require('dotenv').config();
const { Telegraf } = require('telegraf');
const axios = require('axios');
const http = require('http');

// 1. 全局防崩溃
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

const bot = new Telegraf(process.env.BOT_TOKEN);
bot.catch((err) => console.error('🛡 Telegraf 异常:', err.message || err));

// 【抖音解析】
async function parseDouyin(url) {
    const redirectRes = await axios.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15' },
        maxRedirects: 5
    });
    const realUrl = redirectRes.request?.res?.responseUrl || url;
    const match = realUrl.match(/video\/(\d+)/) || realUrl.match(/note\/(\d+)/);
    if (!match) throw new Error('无法识别抖音视频ID');

    const itemId = match[1];
    const { data } = await axios.get(`https://www.iesdouyin.com/web/api/v2/aweme/iteminfo/?item_ids=${itemId}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)' }
    });

    const item = data.item_list?.[0];
    if (!item) throw new Error('未获取到抖音视频数据');

    const title = item.desc || '抖音分享';
    if (item.images && item.images.length > 0) {
        return {
            type: 'images',
            title,
            images: item.images.map(img => img.url_list[0])
        };
    }

    const wmUrl = item.video.play_addr.url_list[0];
    const noWmUrl = wmUrl.replace('/playwm/', '/play/');
    return {
        type: 'video',
        title,
        videoUrl: noWmUrl
    };
}

// 【快手解析】
async function parseKuaishou(url) {
    const resp = await axios.get(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
            'Cookie': 'did=web_' + Math.random().toString(36).substring(2)
        },
        maxRedirects: 5
    });

    const html = resp.data;
    const match = html.match(/window\.PAGE_MODEL\s*=\s*(\{.+?\});<\/script>/) || html.match(/<video[^>]+src="([^">]+)"/);
    
    let videoUrl = null;
    let title = '快手分享';

    if (match && match[1].startsWith('{')) {
        const pageModel = JSON.parse(match[1]);
        const photo = pageModel.photo || pageModel.item;
        videoUrl = photo?.mainMvUrls?.[0]?.url || photo?.photoUrl;
        title = photo?.caption || title;
    } else if (match) {
        videoUrl = match[1];
    }

    if (!videoUrl) throw new Error('提取快手无水印直链失败');
    return {
        type: 'video',
        title,
        videoUrl
    };
}

// 【TikTok 解析】
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

// 【Facebook 解析】
async function parseFacebook(url) {
    const res = await axios.post('https://api.cobalt.tools/api/json', {
        url: url,
        vQuality: '1080'
    }, {
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        },
        timeout: 15000
    });

    if (res.data?.url) {
        return {
            type: 'video',
            title: 'Facebook 视频',
            videoUrl: res.data.url
        };
    }
    throw new Error('无法解析该 Facebook 视频，请确认其为公开视频');
}

// 指令与消息路由
bot.start((ctx) => {
    ctx.reply(
        `🎬 <b>多平台无水印媒体下载机器人</b>\n\n` +
        `直接发送视频或图文链接即可自动解析提取：\n` +
        `▫️ <b>抖音 (Douyin)</b>\n` +
        `▫️ <b>快手 (Kuaishou)</b>\n` +
        `▫️ <b>TikTok</b>\n` +
        `▫️ <b>Facebook</b>\n\n` +
        `<i>支持直接粘贴带文字的内容！</i>`,
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
        statusMsg = await ctx.reply('🔍 正在解析，请稍候...');
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
                `❌ <b>解析失败</b>：${err.message || '网络超时或链接已失效'}`,
                { parse_mode: 'HTML' }
            ).catch(() => {});
        }
    }
});

bot.launch().then(() => console.log('🤖 多平台媒体解析机器人已上线！'));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

