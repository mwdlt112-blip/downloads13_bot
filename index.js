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
    res.end('Media Bot Online\n');
}).listen(PORT, () => {
    console.log(`🌐 保活端口: ${PORT}`);
});

const bot = new Telegraf(process.env.BOT_TOKEN, { handlerTimeout: 90000 });
bot.catch((err) => console.error('🛡 Telegraf 异常:', err.message || err));

// ================= 各平台工业级通道 =================

// 【1. 抖音解析（最新移动端网页 API + 网页重定向解包）】
async function parseDouyin(rawUrl) {
    // 方案 A：直接抓取官方移动端分享页状态
    try {
        const resp = await axios.get(rawUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            },
            maxRedirects: 5,
            timeout: 10000
        });

        const html = resp.data;
        // 匹配 _ROUTER_DATA 或者 RENDER_DATA
        const matchData = html.match(/window\._ROUTER_DATA\s*=\s*(\{.+?\});<\/script>/) || 
                          html.match(/<script id="RENDER_DATA" type="application\/json">(.+?)<\/script>/);

        if (matchData) {
            const rawJson = decodeURIComponent(matchData[1]);
            const json = JSON.parse(rawJson);
            const item = json?.loaderData?.['video_(id)/page']?.videoInfoRes?.item_list?.[0] || 
                         json?.app?.videoInfoRes?.item_list?.[0];
            
            if (item) {
                const title = item.desc || '抖音视频';
                if (item.images && item.images.length > 0) {
                    return { type: 'images', title, images: item.images.map(i => i.url_list[0]) };
                }
                const wmUrl = item.video?.play_addr?.url_list?.[0];
                if (wmUrl) {
                    return { type: 'video', title, videoUrl: wmUrl.replace('/playwm/', '/play/') };
                }
            }
        }
    } catch (e) {}

    // 方案 B：TikWM 全球中继（TikWM 实际同时支持抖音与 TikTok！）
    const resB = await axios.post('https://www.tikwm.com/api/', { url: rawUrl }, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000
    });
    const d = resB.data?.data;
    if (d?.play) {
        return {
            type: d.images?.length ? 'images' : 'video',
            title: d.title || '抖音视频',
            videoUrl: d.play,
            images: d.images
        };
    }

    throw new Error('抖音链接解析失败，请检查是否为私密视频');
}

// 【2. 快手解析（双通道穿透）】
async function parseKuaishou(rawUrl) {
    // 方案 A：穿透并提取快手移动端直链
    try {
        const resp = await axios.get(rawUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15',
                'Cookie': 'did=web_' + Math.random().toString(36).substring(2)
            },
            maxRedirects: 5,
            timeout: 12000
        });

        const html = resp.data;
        const matchVideo = html.match(/src="(https:\/\/[^"]+?\.mp4[^"]*?)"/) || 
                           html.match(/"photoUrl":"(https:\/\/[^"]+?\.mp4[^"]*?)"/) ||
                           html.match(/urlDefault":"(https:\/\/[^"]+?\.mp4[^"]*?)"/);

        if (matchVideo) {
            let videoUrl = matchVideo[1].replace(/\\u002F/g, '/');
            return {
                type: 'video',
                title: '快手无水印视频',
                videoUrl
            };
        }
    } catch (e) {}

    // 方案 B：快手全球中转节点
    const resB = await axios.get(`https://api.lolimi.cn/api/video/kuaishou?url=${encodeURIComponent(rawUrl)}`, {
        timeout: 15000
    });
    if (resB.data?.data?.video) {
        return {
            type: 'video',
            title: resB.data.data.title || '快手无水印视频',
            videoUrl: resB.data.data.video
        };
    }

    throw new Error('快手解析失败，接口暂时受限');
}

// 【3. TikTok 解析（TikWM 引擎）】
async function parseTikTok(rawUrl) {
    const res = await axios.post('https://www.tikwm.com/api/', { url: rawUrl }, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000
    });

    const data = res.data?.data;
    if (!data) throw new Error('TikTok 视频获取失败或已失效');

    const title = data.title || 'TikTok 视频';
    if (data.images && data.images.length > 0) {
        return { type: 'images', title, images: data.images };
    }

    return { type: 'video', title, videoUrl: data.play || data.wmplay };
}

// 【4. Facebook 解析（清洗 URL 后调用 FB 高画质接口）】
async function parseFacebook(rawUrl) {
    // 必须先把链接里的跟踪参数清洗掉，还原为规范 URL
    const cleanUrl = rawUrl.split('?')[0];

    // 节点 1：FB 专用高画质解析网关
    try {
        const res = await axios.get(`https://api.vkrdown.com/fb/download.php?url=${encodeURIComponent(cleanUrl)}`, {
            timeout: 15000
        });
        if (res.data?.data?.download_links?.length > 0) {
            const links = res.data.data.download_links;
            const best = links.find(l => l.quality === 'HD') || links[0];
            return { type: 'video', title: 'Facebook 视频', videoUrl: best.url };
        }
    } catch (e) {}

    // 节点 2：备用 SnapSave 穿透集群
    try {
        const res2 = await axios.get(`https://snapsave.fun/api/video?url=${encodeURIComponent(cleanUrl)}`, {
            timeout: 15000
        });
        const vUrl = res2.data?.data?.hd || res2.data?.data?.sd;
        if (vUrl) {
            return { type: 'video', title: 'Facebook 视频', videoUrl: vUrl };
        }
    } catch (e) {}

    throw new Error('Facebook 视频解析失败，请确保该视频为公开可见');
}

// ================= 消息接收与处理 =================

bot.start((ctx) => {
    ctx.reply(
        `🎬 <b>多平台无水印媒体下载助手</b>\n\n` +
        `直接发送视频链接即可自动提取：\n` +
        `▫️ <b>抖音</b> (视频/图集)\n` +
        `▫️ <b>快手</b> (无水印视频)\n` +
        `▫️ <b>TikTok</b> (高清原画)\n` +
        `▫️ <b>Facebook</b> (公开视频)\n\n` +
        `<i>支持直接粘贴整段文字分享！</i>`,
        { parse_mode: 'HTML' }
    ).catch(() => {});
});

bot.on('text', async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return;

    // 精确剥离 URL（剔除末尾乱码与中文标点符号）
    const match = text.match(/(https?:\/\/[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}[^\s\u4e00-\u9fa5]*)/);
    if (!match) return;

    // 清理 URL 尾部可能粘连的特殊字符（如 :3pm、/ 等）
    let targetUrl = match[1].replace(/[:：;；，,。!！\)\s]+$/, '');
    let statusMsg = null;

    try {
        statusMsg = await ctx.reply('🔍 正在解析媒体源，请稍候...');
        await ctx.sendChatAction('upload_video');

        let result = null;

        if (targetUrl.includes('douyin.com') || targetUrl.includes('iesdouyin.com')) {
            result = await parseDouyin(targetUrl);
        } else if (targetUrl.includes('kuaishou.com') || targetUrl.includes('kwai.com')) {
            result = await parseKuaishou(targetUrl);
        } else if (targetUrl.includes('tiktok.com')) {
            result = await parseTikTok(targetUrl);
        } else if (targetUrl.includes('facebook.com') || targetUrl.includes('fb.watch')) {
            result = await parseFacebook(targetUrl);
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

// 重试启动机制
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
