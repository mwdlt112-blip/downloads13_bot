require('dotenv').config();
const { Telegraf } = require('telegraf');
const axios = require('axios');
const http = require('http');

// 1. 全局守护
process.on('uncaughtException', (err) => console.error('🛡 全局异常:', err.message || err));
process.on('unhandledRejection', (reason) => console.error('🛡 Promise异常:', reason?.message || reason));

// 2. Render 保活 HTTP 服务
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Parser Bot is running\n');
}).listen(PORT, () => {
    console.log(`🌐 保活端口: ${PORT}`);
});

const bot = new Telegraf(process.env.BOT_TOKEN, { handlerTimeout: 90000 });
bot.catch((err) => console.error('🛡 Telegraf 异常:', err.message || err));

// ================= 各平台工业级通道 =================

// 【1. 抖音 & 快手：使用自带动态代理池的海外专线网关】
async function parseChinaShortVideo(cleanUrl) {
    // 专线 1：全球免流跨域短视频专线
    try {
        const res = await axios.get(`https://tenapi.cn/v2/video?url=${encodeURIComponent(cleanUrl)}`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15'
            },
            timeout: 15000
        });
        if (res.data?.code === 200 && res.data?.data?.url) {
            return {
                type: 'video',
                title: res.data.data.title || '无水印精彩视频',
                videoUrl: res.data.data.url
            };
        }
    } catch (e) {}

    // 专线 2：海外多媒体聚合节点 (专门穿透机房 IP)
    try {
        const res2 = await axios.get(`https://free-api.heheda.top/api/video/jx?url=${encodeURIComponent(cleanUrl)}`, {
            timeout: 15000
        });
        if (res2.data?.data?.url) {
            return {
                type: 'video',
                title: res2.data.data.title || '无水印精彩视频',
                videoUrl: res2.data.data.url
            };
        }
    } catch (e) {}

    // 专线 3：针对快手的直接解密通道
    if (cleanUrl.includes('kuaishou.com') || cleanUrl.includes('kwai.com')) {
        const res3 = await axios.get(`https://api.oick.cn/api/kuaishou?url=${encodeURIComponent(cleanUrl)}`, {
            timeout: 15000
        });
        if (res3.data?.play_addr) {
            return {
                type: 'video',
                title: res3.data.title || '快手无水印视频',
                videoUrl: res3.data.play_addr
            };
        }
    }

    throw new Error('国内平台对海外服务器发起防爬风控，接口通道正在切换');
}

// 【2. TikTok 解析引擎 (稳定高可用)】
async function parseTikTok(cleanUrl) {
    const res = await axios.post('https://www.tikwm.com/api/', { url: cleanUrl }, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000
    });

    const data = res.data?.data;
    if (!data) throw new Error('TikTok 视频已被删除或设为私密');

    const title = data.title || 'TikTok 视频';
    if (data.images && data.images.length > 0) {
        return { type: 'images', title, images: data.images };
    }

    return { type: 'video', title, videoUrl: data.play || data.wmplay };
}

// 【3. Facebook 解析引擎 (全球公共多节点轮询)】
async function parseFacebook(cleanUrl) {
    // 方案 1：全球媒体提取网关
    try {
        const res = await axios.get(`https://api.giftedtech.web.id/api/download/facebook?url=${encodeURIComponent(cleanUrl)}`, {
            timeout: 12000
        });
        const stream = res.data?.result?.hd || res.data?.result?.sd;
        if (stream) {
            return { type: 'video', title: 'Facebook 视频', videoUrl: stream };
        }
    } catch (e) {}

    // 方案 2：Cobalt 官方高可用中继
    try {
        const resCobalt = await axios.post('https://co.wuk.sh/api/json', {
            url: cleanUrl,
            vQuality: '720'
        }, {
            headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
            timeout: 12000
        });
        if (resCobalt.data?.url) {
            return { type: 'video', title: 'Facebook 视频', videoUrl: resCobalt.data.url };
        }
    } catch (e) {}

    throw new Error('Facebook 视频解析失败，请确认视频为公开可见');
}

// ================= 消息路由与分发 =================

bot.start((ctx) => {
    ctx.reply(
        `🎬 <b>多平台去水印媒体下载机器人</b>\n\n` +
        `直接发送视频链接即可自动提取：\n` +
        `▫️ <b>抖音 (Douyin)</b>\n` +
        `▫️ <b>快手 (Kuaishou)</b>\n` +
        `▫️ <b>TikTok</b>\n` +
        `▫️ <b>Facebook</b>\n\n` +
        `<i>支持直接粘贴整段文字！</i>`,
        { parse_mode: 'HTML' }
    ).catch(() => {});
});

bot.on('text', async (ctx) => {
    const rawText = ctx.message.text.trim();
    if (rawText.startsWith('/')) return;

    // 精确提取 URL
    const match = rawText.match(/(https?:\/\/[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}[^\s\u4e00-\u9fa5]*)/);
    if (!match) return;

    // 清洗末尾特殊符号
    let cleanUrl = match[1].replace(/[:：;；，,。!！\)\s]+$/, '');
    if (cleanUrl.includes('facebook.com') || cleanUrl.includes('fb.watch')) {
        cleanUrl = cleanUrl.split('?')[0];
    }

    let statusMsg = null;

    try {
        statusMsg = await ctx.reply('🔍 正在解析媒体源，请稍候...');
        await ctx.sendChatAction('upload_video');

        let result = null;

        if (cleanUrl.includes('douyin.com') || cleanUrl.includes('iesdouyin.com') || 
            cleanUrl.includes('kuaishou.com') || cleanUrl.includes('kwai.com')) {
            result = await parseChinaShortVideo(cleanUrl);
        } else if (cleanUrl.includes('tiktok.com')) {
            result = await parseTikTok(cleanUrl);
        } else if (cleanUrl.includes('facebook.com') || cleanUrl.includes('fb.watch')) {
            result = await parseFacebook(cleanUrl);
        } else {
            if (statusMsg) await ctx.deleteMessage(statusMsg.message_id).catch(() => {});
            return;
        }

        // 发送结果
        if (result.type === 'video') {
            await ctx.replyWithVideo(result.videoUrl, {
                caption: `🎬 <b>${result.title}</b>\n\n✅ <i>无水印解析成功</i>`,
                parse_mode: 'HTML'
            });
        } else if (result.type === 'images') {
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

// 重试启动循环
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
