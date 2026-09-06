require('dotenv').config();
const { Telegraf } = require('telegraf');
const axios = require('axios');
const http = require('http');

// 1. 全局防崩溃守护
process.on('uncaughtException', (err) => console.error('🛡 全局异常:', err.message || err));
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

// ================= 各平台无防火墙高可用引擎 =================

// 【1. 抖音解析（多路免防护聚合降级）】
async function parseDouyin(rawText, cleanUrl) {
    // 方案 1：开放聚合短视频网关 A
    try {
        const res = await axios.get(`https://api.kxzjoker.cn/api/video_jx?url=${encodeURIComponent(cleanUrl)}`, {
            timeout: 10000,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });
        if (res.data?.data?.url) {
            return {
                type: 'video',
                title: res.data.data.title || '抖音无水印视频',
                videoUrl: res.data.data.url
            };
        }
    } catch (e) {}

    // 方案 2：开放短视频网关 B
    try {
        const res2 = await axios.get(`https://api.52vmy.cn/api/wl/dsp/video?url=${encodeURIComponent(cleanUrl)}`, {
            timeout: 10000
        });
        if (res2.data?.data?.url) {
            return {
                type: 'video',
                title: res2.data.data.title || '抖音无水印视频',
                videoUrl: res2.data.data.url
            };
        }
    } catch (e) {}

    // 方案 3：全球中转 TikWM（同时兼容解析部分抖音短链）
    try {
        const res3 = await axios.post('https://www.tikwm.com/api/', { url: cleanUrl }, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 12000
        });
        const d = res3.data?.data;
        if (d?.play) {
            if (d.images && d.images.length > 0) {
                return { type: 'images', title: d.title || '抖音图集', images: d.images };
            }
            return { type: 'video', title: d.title || '抖音视频', videoUrl: d.play };
        }
    } catch (e) {}

    throw new Error('抖音解析通道繁忙，请稍后重试');
}

// 【2. 快手解析（双向穿透引擎）】
async function parseKuaishou(rawText, cleanUrl) {
    // 方案 1：专用聚合提取通道
    try {
        const res = await axios.get(`https://api.kxzjoker.cn/api/video_jx?url=${encodeURIComponent(cleanUrl)}`, {
            timeout: 10000
        });
        if (res.data?.data?.url) {
            return {
                type: 'video',
                title: res.data.data.title || '快手无水印视频',
                videoUrl: res.data.data.url
            };
        }
    } catch (e) {}

    // 方案 2：移动端重定向直连提取
    try {
        const redirectRes = await axios.get(cleanUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15',
                'Cookie': 'did=web_' + Date.now()
            },
            maxRedirects: 5,
            timeout: 12000
        });
        const html = redirectRes.data;
        const match = html.match(/src="(https:\/\/[^"]+?\.mp4[^"]*?)"/) || 
                      html.match(/"photoUrl":"(https:\/\/[^"]+?\.mp4[^"]*?)"/);
        if (match) {
            return {
                type: 'video',
                title: '快手分享视频',
                videoUrl: match[1].replace(/\\u002F/g, '/')
            };
        }
    } catch (e) {}

    throw new Error('快手视频提取失败，请检查链接是否有效');
}

// 【3. TikTok 解析（TikWM 引擎）】
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

// 【4. Facebook 解析（多通道无鉴权解析）】
async function parseFacebook(cleanUrl) {
    // 方案 1：全球媒体提取网关
    try {
        const res = await axios.get(`https://api.agungny.my.id/api/facebook?url=${encodeURIComponent(cleanUrl)}`, {
            timeout: 12000
        });
        const stream = res.data?.result?.hd || res.data?.result?.sd;
        if (stream) {
            return { type: 'video', title: 'Facebook 视频', videoUrl: stream };
        }
    } catch (e) {}

    // 方案 2：备用 FB 下载网关
    try {
        const res2 = await axios.get(`https://api.vkrdown.com/fb/download.php?url=${encodeURIComponent(cleanUrl)}`, {
            timeout: 12000
        });
        const links = res2.data?.data?.download_links;
        if (links && links.length > 0) {
            const best = links.find(l => l.quality === 'HD') || links[0];
            return { type: 'video', title: 'Facebook 视频', videoUrl: best.url };
        }
    } catch (e) {}

    throw new Error('Facebook 视频解析失败，请确认该内容为公开视频');
}

// ================= 消息接收与处理 =================

bot.start((ctx) => {
    ctx.reply(
        `🎬 <b>多平台无水印媒体下载助手</b>\n\n` +
        `直接发送视频链接即可自动提取：\n` +
        `▫️ <b>抖音 / 快手</b>\n` +
        `▫️ <b>TikTok</b>\n` +
        `▫️ <b>Facebook</b>\n\n` +
        `<i>支持直接粘贴带文案的分享内容！</i>`,
        { parse_mode: 'HTML' }
    ).catch(() => {});
});

bot.on('text', async (ctx) => {
    const rawText = ctx.message.text.trim();
    if (rawText.startsWith('/')) return;

    // 精确剥离标准 http/https 链接
    const match = rawText.match(/(https?:\/\/[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}[^\s\u4e00-\u9fa5]*)/);
    if (!match) return;

    // 清洗掉末尾可能黏附的各种特殊符号与跟踪参数
    let cleanUrl = match[1].replace(/[:：;；，,。!！\)\s]+$/, '');
    if (cleanUrl.includes('facebook.com') || cleanUrl.includes('fb.watch')) {
        cleanUrl = cleanUrl.split('?')[0]; // 清洗 FB 的跟踪后缀
    }

    let statusMsg = null;

    try {
        statusMsg = await ctx.reply('🔍 正在解析，请稍候...');
        await ctx.sendChatAction('upload_video');

        let result = null;

        if (cleanUrl.includes('douyin.com') || cleanUrl.includes('iesdouyin.com')) {
            result = await parseDouyin(rawText, cleanUrl);
        } else if (cleanUrl.includes('kuaishou.com') || cleanUrl.includes('kwai.com')) {
            result = await parseKuaishou(rawText, cleanUrl);
        } else if (cleanUrl.includes('tiktok.com')) {
            result = await parseTikTok(cleanUrl);
        } else if (cleanUrl.includes('facebook.com') || cleanUrl.includes('fb.watch')) {
            result = await parseFacebook(cleanUrl);
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

// 重试启动机制
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
