require('dotenv').config();
const { Telegraf } = require('telegraf');
const axios = require('axios');
const http = require('http');

// 1. 全局异常防崩溃
process.on('uncaughtException', (err) => console.error('🛡 全局异常:', err.message || err));
process.on('unhandledRejection', (reason) => console.error('🛡 Promise异常:', reason?.message || reason));

// 2. Render 保活 HTTP
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Parser Bot Online\n');
}).listen(PORT, () => {
    console.log(`🌐 保活监听端口: ${PORT}`);
});

const bot = new Telegraf(process.env.BOT_TOKEN, { handlerTimeout: 90000 });
bot.catch((err) => console.error('🛡 Telegraf 异常:', err.message || err));

// ================= 核心解析引擎 =================

// 【对接 dyxhsdownloader 的解析引擎（专攻抖音、快手）】
async function parseViaDyXhs(rawText) {
    // 伪装浏览器请求该平台的解析 API
    const response = await axios.post('https://api.dyxhsdownloader.com/api/video/parse', {
        url: rawText
    }, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
            'Referer': 'https://dyxhsdownloader.com/',
            'Origin': 'https://dyxhsdownloader.com',
            'Content-Type': 'application/json'
        },
        timeout: 15000
    }).catch(async () => {
        // 备用端点：部分镜像部署在根路由 /parse
        return await axios.post('https://dyxhsdownloader.com/api/parse', {
            url: rawText
        }, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Referer': 'https://dyxhsdownloader.com/',
                'Content-Type': 'application/json'
            },
            timeout: 15000
        });
    });

    const res = response.data;
    const data = res?.data || res;

    if (!data) throw new Error('解析服务未返回有效数据');

    const title = data.title || data.desc || '精彩无水印视频';

    // 1. 图集类型
    if (data.images && data.images.length > 0) {
        return {
            type: 'images',
            title,
            images: data.images.map(img => (typeof img === 'string' ? img : img.url || img.url_list?.[0]))
        };
    }

    // 2. 视频直链提取
    const videoUrl = data.video_url || data.url || data.play_url || data.video;
    if (videoUrl) {
        return {
            type: 'video',
            title,
            videoUrl
        };
    }

    throw new Error('未能提取到无水印媒体直链');
}

// 【TikTok 稳定引擎】
async function parseTikTok(url) {
    const res = await axios.post('https://www.tikwm.com/api/', { url: url }, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000
    });

    const data = res.data?.data;
    if (!data) throw new Error('TikTok 视频获取失败');

    const title = data.title || 'TikTok 视频';
    if (data.images && data.images.length > 0) {
        return { type: 'images', title, images: data.images };
    }

    return { type: 'video', title, videoUrl: data.play || data.wmplay };
}

// 【Facebook 稳定引擎】
async function parseFacebook(url) {
    const cleanUrl = url.split('?')[0];
    const res = await axios.get(`https://api.giftedtech.web.id/api/download/facebook?url=${encodeURIComponent(cleanUrl)}`, {
        timeout: 15000
    });

    const video = res.data?.result?.hd || res.data?.result?.sd;
    if (video) {
        return { type: 'video', title: 'Facebook 视频', videoUrl: video };
    }
    throw new Error('Facebook 视频解析失败，请确认是否为公开视频');
}

// ================= 消息路由与分发 =================

bot.start((ctx) => {
    ctx.reply(
        `🎬 <b>多平台去水印下载机器人</b>\n\n` +
        `直接发送带链接的文字即可自动提取：\n` +
        `▫️ <b>抖音 / 快手</b> (直连极速解析)\n` +
        `▫️ <b>TikTok</b> (无水印视频/图集)\n` +
        `▫️ <b>Facebook</b> (公开高清视频)\n\n` +
        `<i>支持直接把 App 复制的全部文本粘贴发送！</i>`,
        { parse_mode: 'HTML' }
    ).catch(() => {});
});

bot.on('text', async (ctx) => {
    const rawText = ctx.message.text.trim();
    if (rawText.startsWith('/')) return;

    // 提取消息中的 URL
    const match = rawText.match(/(https?:\/\/[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}[^\s\u4e00-\u9fa5]*)/);
    if (!match) return;

    const targetUrl = match[1].replace(/[:：;；，,。!！\)\s]+$/, '');
    let statusMsg = null;

    try {
        statusMsg = await ctx.reply('🔍 正在解析媒体源，请稍候...');
        await ctx.sendChatAction('upload_video');

        let result = null;

        // 抖音与快手统一走该平台的成熟解析网关
        if (targetUrl.includes('douyin.com') || targetUrl.includes('iesdouyin.com') || 
            targetUrl.includes('kuaishou.com') || targetUrl.includes('kwai.com')) {
            result = await parseViaDyXhs(rawText);
        } else if (targetUrl.includes('tiktok.com')) {
            result = await parseTikTok(targetUrl);
        } else if (targetUrl.includes('facebook.com') || targetUrl.includes('fb.watch')) {
            result = await parseFacebook(targetUrl);
        } else {
            if (statusMsg) await ctx.deleteMessage(statusMsg.message_id).catch(() => {});
            return;
        }

        // 发送视频
        if (result.type === 'video') {
            await ctx.replyWithVideo(result.videoUrl, {
                caption: `🎬 <b>${result.title}</b>\n\n✅ <i>无水印解析成功</i>`,
                parse_mode: 'HTML'
            });
        } else if (result.type === 'images') {
            // 发送图集
            const mediaGroup = result.images.slice(0, 10).map((img, idx) => ({
                type: 'photo',
                media: img,
                caption: idx === 0 ? `🖼 <b>${result.title}</b> (共 ${result.images.length} 张图)` : '',
                parse_mode: 'HTML'
            }));
            await ctx.replyWithMediaGroup(mediaGroup);
        }

        if (statusMsg) await ctx.deleteMessage(statusMsg.message_id).catch(() => {});

    } catch (err) {
        console.error('解析错误:', err.message);
        if (statusMsg) {
            await ctx.telegram.editMessageText(
                ctx.chat.id,
                statusMsg.message_id,
                null,
                `❌ <b>解析失败</b>：${err.message || '网络连接超时'}`,
                { parse_mode: 'HTML' }
            ).catch(() => {});
        }
    }
});

// 自动连接重试
async function startBotWithRetry(retries = 5, delay = 5000) {
    for (let i = 0; i < retries; i++) {
        try {
            console.log(`⏳ 连接 Telegram (第 ${i + 1} 次)...`);
            await bot.launch();
            console.log('🤖 机器人已成功上线！');
            return;
        } catch (err) {
            console.error(`⚠️ 连接失败: ${err.message}，${delay / 1000} 秒后重试...`);
            if (i < retries - 1) {
                await new Promise(res => setTimeout(res, delay));
            }
        }
    }
}

startBotWithRetry();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
