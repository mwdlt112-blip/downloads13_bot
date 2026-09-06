require('dotenv').config();
const { Telegraf } = require('telegraf');
const axios = require('axios');
const http = require('http');

// 1. 全局守护
process.on('uncaughtException', (err) => console.error('🛡 异常:', err.message || err));
process.on('unhandledRejection', (reason) => console.error('🛡 Promise异常:', reason?.message || reason));

// 2. Render 保活 HTTP
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot Online\n');
}).listen(PORT, () => {
    console.log(`🌐 保活服务端口: ${PORT}`);
});

const bot = new Telegraf(process.env.BOT_TOKEN, { handlerTimeout: 90000 });
bot.catch((err) => console.error('🛡 Telegraf 异常:', err.message || err));

// ================= 各平台工业级解析通道 =================

// 【1. 抖音解析 - 移动短链穿透 + 免鉴权源数据】
async function parseDouyinNative(url) {
    // 跟随 302 重定向拿到长链接
    const headRes = await axios.get(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.38'
        },
        maxRedirects: 5,
        timeout: 10000
    });

    const realUrl = headRes.request?.res?.responseUrl || url;
    const match = realUrl.match(/video\/(\d+)/) || realUrl.match(/note\/(\d+)/);
    if (!match) throw new Error('提取抖音 ID 失败');

    const videoId = match[1];

    // 请求官方 CDN 详情
    const apiRes = await axios.get(`https://www.iesdouyin.com/web/api/v2/aweme/iteminfo/?item_ids=${videoId}`, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)'
        },
        timeout: 10000
    });

    const item = apiRes.data?.item_list?.[0];
    if (!item) throw new Error('视频信息不存在或已被删除');

    const title = item.desc || '抖音视频';

    // 图集情况
    if (item.images && item.images.length > 0) {
        return {
            type: 'images',
            title,
            images: item.images.map(img => img.url_list[0])
        };
    }

    // 视频去水印
    const wmUrl = item.video.play_addr.url_list[0];
    const noWmUrl = wmUrl.replace('/playwm/', '/play/');
    return {
        type: 'video',
        title,
        videoUrl: noWmUrl
    };
}

// 【2. 快手解析 - 穿透短链与移动 SSR 提取】
async function parseKuaishouNative(url) {
    const res = await axios.get(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1',
            'Cookie': 'did=web_' + Date.now()
        },
        maxRedirects: 5,
        timeout: 12000
    });

    const html = res.data;
    // 匹配快手视频直链 (mp4 模式)
    const matchMp4 = html.match(/src="(https:\/\/[^"]+\.mp4[^"]*)"/) || html.match(/urlDefault":"(https:\/\/[^"]+\.mp4[^"]*)"/);
    if (matchMp4) {
        let videoUrl = matchMp4[1].replace(/\\u002F/g, '/');
        return {
            type: 'video',
            title: '快手无水印视频',
            videoUrl
        };
    }

    // 备用：从快手公开微服务提取
    const api = `https://api.songzixian.com/api/kuaishou?url=${encodeURIComponent(url)}`;
    const backupRes = await axios.get(api, { timeout: 10000 });
    if (backupRes.data?.data?.video_url) {
        return {
            type: 'video',
            title: backupRes.data.data.title || '快手视频',
            videoUrl: backupRes.data.data.video_url
        };
    }

    throw new Error('快手视频解析失败');
}

// 【3. TikTok 解析 - TikWM 核心引擎】
async function parseTikTok(url) {
    const res = await axios.post('https://www.tikwm.com/api/', { url: url }, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000
    });

    const data = res.data?.data;
    if (!data) throw new Error('TikTok 视频已被删除或私密');

    const title = data.title || 'TikTok 视频';
    if (data.images && data.images.length > 0) {
        return { type: 'images', title, images: data.images };
    }

    return { type: 'video', title, videoUrl: data.play || data.wmplay };
}

// 【4. Facebook 解析 - 采用全球可用的 SnapSave 逆向代理】
async function parseFacebook(url) {
    // 通道 1: Rapid 节点
    try {
        const res = await axios.get(`https://api.fabdl.com/facebook/get?url=${encodeURIComponent(url)}`, {
            timeout: 12000
        });
        const stream = res.data?.result?.medias?.find(m => m.quality === 'hd') || res.data?.result?.medias?.[0];
        if (stream?.url) {
            return { type: 'video', title: res.data.result.title || 'Facebook 视频', videoUrl: stream.url };
        }
    } catch (e) {}

    // 通道 2: Cobalt 官方可用集群
    try {
        const cobaltRes = await axios.post('https://api.cobalt.tools/api/json', {
            url: url
        }, {
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0'
            },
            timeout: 12000
        });
        if (cobaltRes.data?.url) {
            return { type: 'video', title: 'Facebook 视频', videoUrl: cobaltRes.data.url };
        }
    } catch (e) {}

    throw new Error('Facebook 视频解析失败，请确认该视频是否为公开可见');
}

// ================= 消息接收与处理 =================

bot.start((ctx) => {
    ctx.reply(
        `🎬 <b>多平台无水印媒体下载助手</b>\n\n` +
        `直接发送视频或图文链接即可自动解析：\n` +
        `▫️ <b>抖音</b> (支持长视频与图集)\n` +
        `▫️ <b>快手</b> (视频提取)\n` +
        `▫️ <b>TikTok</b> (无水印)\n` +
        `▫️ <b>Facebook</b> (公开高清)\n\n` +
        `<i>支持直接粘贴带文案的整段文字！</i>`,
        { parse_mode: 'HTML' }
    ).catch(() => {});
});

bot.on('text', async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return;

    // 精确提取合规的 http/https 网址（剔除末尾多余符号与中文标点）
    const match = text.match(/(https?:\/\/[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}[^\s\u4e00-\u9fa5]*)/);
    if (!match) return;

    let targetUrl = match[1].replace(/[：:;；，,。!！\)\s]+$/, '');
    let statusMsg = null;

    try {
        statusMsg = await ctx.reply('🔍 正在解析媒体源，请稍候...');
        await ctx.sendChatAction('upload_video');

        let result = null;

        if (targetUrl.includes('douyin.com') || targetUrl.includes('iesdouyin.com')) {
            result = await parseDouyinNative(targetUrl);
        } else if (targetUrl.includes('kuaishou.com') || targetUrl.includes('kwai.com')) {
            result = await parseKuaishouNative(targetUrl);
        } else if (targetUrl.includes('tiktok.com')) {
            result = await parseTikTok(targetUrl);
        } else if (targetUrl.includes('facebook.com') || targetUrl.includes('fb.watch')) {
            result = await parseFacebook(targetUrl);
        } else {
            if (statusMsg) await ctx.deleteMessage(statusMsg.message_id).catch(() => {});
            return;
        }

        // 发送解析结果
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

// 启动重试机制
async function startBotWithRetry(retries = 5, delay = 5000) {
    for (let i = 0; i < retries; i++) {
        try {
            console.log(`⏳ 连接 Telegram 伺服器 (第 ${i + 1} 次)...`);
            await bot.launch();
            console.log('🤖 多平台媒体解析机器人已成功上线运行！');
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
