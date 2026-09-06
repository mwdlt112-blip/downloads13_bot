require('dotenv').config();
const { Telegraf } = require('telegraf');
const axios = require('axios');
const http = require('http');

// 1. 全局防崩溃守护
process.on('uncaughtException', (err) => console.error('🛡 全局捕获异常:', err.message || err));
process.on('unhandledRejection', (reason) => console.error('🛡 Promise异常:', reason?.message || reason));

// 2. Render 保活 HTTP 服务
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Media Downloader Bot is running!\n');
}).listen(PORT, () => {
    console.log(`🌐 保活服务运行于端口 ${PORT}`);
});

// 3. 初始化 Telegraf
const bot = new Telegraf(process.env.BOT_TOKEN, {
    handlerTimeout: 90000
});

bot.catch((err) => console.error('🛡 Telegraf 内部异常:', err.message || err));

// ================= 各平台高可用解析引擎 =================

// 【1. 抖音 & 快手解析引擎（通过稳定免签接口）】
async function parseChineseShortVideo(url) {
    // 使用公开稳定的短视频解析中继
    const apiUrl = `https://api.pearktrue.cn/api/video/get.php?url=${encodeURIComponent(url)}`;
    const res = await axios.get(apiUrl, { timeout: 15000 });

    if (res.data?.code === 200 && res.data?.data) {
        const data = res.data.data;
        return {
            type: 'video',
            title: data.title || '无水印短视频',
            videoUrl: data.url
        };
    }

    // 备用接口方案
    const backupUrl = `https://tenapi.cn/v2/video?url=${encodeURIComponent(url)}`;
    const backupRes = await axios.get(backupUrl, { timeout: 15000 });
    if (backupRes.data?.code === 200 && backupRes.data?.data?.url) {
        const data = backupRes.data.data;
        return {
            type: 'video',
            title: data.title || '无水印短视频',
            videoUrl: data.url
        };
    }

    throw new Error('视频提取失败，链接可能失效或有防盗链');
}

// 【2. TikTok 解析引擎】
async function parseTikTok(url) {
    const res = await axios.post('https://www.tikwm.com/api/', { url: url }, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000
    });

    const data = res.data?.data;
    if (!data) throw new Error('TikTok 视频解析失败或已被删除');

    const title = data.title || 'TikTok 视频';
    if (data.images && data.images.length > 0) {
        return {
            type: 'images',
            title,
            images: data.images
        };
    }

    const videoUrl = data.play || data.wmplay;
    return {
        type: 'video',
        title,
        videoUrl
    };
}

// 【3. Facebook 解析引擎】
async function parseFacebook(url) {
    // 方案 1：使用快解析接口
    try {
        const res = await axios.get(`https://api.agungny.my.id/api/facebook?url=${encodeURIComponent(url)}`, { timeout: 15000 });
        if (res.data?.result?.hd || res.data?.result?.sd) {
            return {
                type: 'video',
                title: 'Facebook 视频',
                videoUrl: res.data.result.hd || res.data.result.sd
            };
        }
    } catch (e) {
        // 尝试备用节点
    }

    // 方案 2：使用第三方 FB 解析中转
    const res2 = await axios.get(`https://tools.betabotz.eu.org/tools/fbdl?url=${encodeURIComponent(url)}`, { timeout: 15000 });
    if (res2.data?.result?.Normal_video || res2.data?.result?.HD) {
        return {
            type: 'video',
            title: 'Facebook 视频',
            videoUrl: res2.data.result.HD || res2.data.result.Normal_video
        };
    }

    throw new Error('无法提取此 Facebook 视频，请确认是否为公开视频');
}

// ================= Telegram 消息处理与路由 =================

bot.start((ctx) => {
    ctx.reply(
        `🎬 <b>多平台无水印媒体下载机器人</b>\n\n` +
        `直接发送视频链接即可自动提取：\n` +
        `▫️ <b>抖音 (Douyin)</b>\n` +
        `▫️ <b>快手 (Kuaishou)</b>\n` +
        `▫️ <b>TikTok</b>\n` +
        `▫️ <b>Facebook</b>\n\n` +
        `<i>支持直接粘贴带文案的分享链接！</i>`,
        { parse_mode: 'HTML' }
    ).catch(() => {});
});

bot.on('text', async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return;

    const urlMatch = text.match(/https?:\/\/[^\s]+/);
    if (!urlMatch) return;

    const targetUrl = urlMatch[0];
    let statusMsg = null;

    try {
        statusMsg = await ctx.reply('🔍 正在解析媒体源，请稍候...');
        await ctx.sendChatAction('upload_video');

        let result = null;

        if (targetUrl.includes('douyin.com') || targetUrl.includes('iesdouyin.com') || 
            targetUrl.includes('kuaishou.com') || targetUrl.includes('kwai.com')) {
            result = await parseChineseShortVideo(targetUrl);
        } else if (targetUrl.includes('tiktok.com')) {
            result = await parseTikTok(targetUrl);
        } else if (targetUrl.includes('facebook.com') || targetUrl.includes('fb.watch')) {
            result = await parseFacebook(targetUrl);
        } else {
            if (statusMsg) await ctx.deleteMessage(statusMsg.message_id).catch(() => {});
            return;
        }

        // 发送解析到的视频
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
        console.error('解析处理错误:', err.message);
        if (statusMsg) {
            await ctx.telegram.editMessageText(
                ctx.chat.id,
                statusMsg.message_id,
                null,
                `❌ <b>解析失败</b>：${err.message || '网络超时或链接无效'}`,
                { parse_mode: 'HTML' }
            ).catch(() => {});
        }
    }
});

// 健壮的启动逻辑
async function startBotWithRetry(retries = 5, delay = 5000) {
    for (let i = 0; i < retries; i++) {
        try {
            console.log(`⏳ 正在尝试连接 Telegram 伺服器 (第 ${i + 1} 次)...`);
            await bot.launch();
            console.log('🤖 多平台媒体解析机器人已成功上线运行！');
            return;
        } catch (err) {
            console.error(`⚠️ 连接失败: ${err.message}，将在 ${delay / 1000} 秒后重试...`);
            if (i < retries - 1) {
                await new Promise(res => setTimeout(res, delay));
            }
        }
    }
}

startBotWithRetry();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
