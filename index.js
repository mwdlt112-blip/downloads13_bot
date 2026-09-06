require('dotenv').config();
const { Telegraf } = require('telegraf');
const axios = require('axios');
const http = require('http');

// 1. 全局防崩溃守护
process.on('uncaughtException', (err) => console.error('🛡 全局异常:', err.message || err));
process.on('unhandledRejection', (reason) => console.error('🛡 Promise异常:', reason?.message || reason));

// 2. Render 保活 HTTP 服务
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Media Downloader Bot is running!\n');
}).listen(PORT, () => {
    console.log(`🌐 保活服务运行于端口 ${PORT}`);
});

const bot = new Telegraf(process.env.BOT_TOKEN, {
    handlerTimeout: 90000
});

bot.catch((err) => console.error('🛡 Telegraf 异常:', err.message || err));

// ================= 各平台高可用解析引擎 =================

// 【1. 抖音 & 快手解析引擎（多接口自动轮询）】
async function parseChineseShortVideo(url) {
    // 方案 A：万能短视频解析接口 (海外访问友好)
    try {
        const resA = await axios.get(`https://api.oick.cn/api/video?url=${encodeURIComponent(url)}`, {
            timeout: 10000,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });
        if (resA.data?.code === 200 && resA.data?.data?.play) {
            return {
                type: 'video',
                title: resA.data.data.title || '无水印短视频',
                videoUrl: resA.data.data.play
            };
        }
    } catch (e) {}

    // 方案 B：备用通用提取中继
    try {
        const resB = await axios.get(`https://api.linhun.vip/api/ShortVideo?url=${encodeURIComponent(url)}&apiKey=free`, {
            timeout: 10000
        });
        if (resB.data?.code === 200 && (resB.data?.video || resB.data?.url)) {
            return {
                type: 'video',
                title: resB.data.title || '无水印短视频',
                videoUrl: resB.data.video || resB.data.url
            };
        }
    } catch (e) {}

    // 方案 C：直接逆向解析（针对抖音）
    if (url.includes('douyin.com')) {
        const redirectRes = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)' },
            maxRedirects: 5,
            timeout: 10000
        });
        const realUrl = redirectRes.request?.res?.responseUrl || url;
        const match = realUrl.match(/video\/(\d+)/) || realUrl.match(/note\/(\d+)/);
        if (match) {
            const itemId = match[1];
            const { data } = await axios.get(`https://www.iesdouyin.com/web/api/v2/aweme/iteminfo/?item_ids=${itemId}`, {
                headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)' },
                timeout: 10000
            });
            const item = data.item_list?.[0];
            if (item) {
                const title = item.desc || '抖音视频';
                if (item.images && item.images.length > 0) {
                    return { type: 'images', title, images: item.images.map(img => img.url_list[0]) };
                }
                const wmUrl = item.video.play_addr.url_list[0];
                return { type: 'video', title, videoUrl: wmUrl.replace('/playwm/', '/play/') };
            }
        }
    }

    throw new Error('当前解析接口繁忙或链接已失效');
}

// 【2. TikTok 解析引擎 (稳定可用)】
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

// 【3. Facebook 解析引擎（多通道轮询）】
async function parseFacebook(url) {
    // 方案 A：Cobalt 官方高可用实例
    try {
        const resA = await axios.post('https://co.wuk.sh/api/json', {
            url: url,
            vQuality: '720'
        }, {
            headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
            timeout: 12000
        });
        if (resA.data?.url) {
            return { type: 'video', title: 'Facebook 视频', videoUrl: resA.data.url };
        }
    } catch (e) {}

    // 方案 B：SnapSave 接口代理
    try {
        const resB = await axios.get(`https://api.dorratz.com/fbvideo?url=${encodeURIComponent(url)}`, {
            timeout: 12000
        });
        const video = resB.data?.data?.media?.video_hd || resB.data?.data?.media?.video_sd;
        if (video) {
            return { type: 'video', title: 'Facebook 视频', videoUrl: video };
        }
    } catch (e) {}

    // 方案 C：通用公开提取通道
    try {
        const resC = await axios.get(`https://vihangayt.me/download/fb?url=${encodeURIComponent(url)}`, {
            timeout: 12000
        });
        if (resC.data?.status && resC.data?.data?.urls?.length > 0) {
            const best = resC.data.data.urls.find(u => u.subname === 'HD') || resC.data.data.urls[0];
            return { type: 'video', title: 'Facebook 视频', videoUrl: best.url };
        }
    } catch (e) {}

    throw new Error('无法解析该 Facebook 视频，请确认其为公开视频');
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
        `<i>支持直接粘贴带文案的分享内容！</i>`,
        { parse_mode: 'HTML' }
    ).catch(() => {});
});

bot.on('text', async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return;

    // 提取消息中的 URL
    const urlMatch = text.match(/https?:\/\/[^\s]+/);
    if (!urlMatch) return;

    // 清理 URL 尾部可能粘连的特殊字符
    let targetUrl = urlMatch[0].replace(/[：:;；，,。]+$/, '');
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

// 重试启动机制
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
