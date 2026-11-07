import { mediaFirstFrameDataUrl } from './gif-to-video.js';
import { detectImageType } from './image-type.js';

function isMedia(part) {
  return part?.type === 'image_url' || part?.type === 'video_url';
}

export function hasUserMedia(messages) {
  return Array.isArray(messages) && messages.some((message) =>
    message?.role === 'user' && Array.isArray(message.content) && message.content.some(isMedia));
}

export function isMediaRejection(status, detail) {
  if (status === 415) return true;
  if (status !== 400 && status !== 422) return false;
  // 优先看错误字段，避免将网关回显的整个请求（包含媒体和模型名）误判为媒体错误。
  let reason = String(detail).slice(0, 4096);
  try {
    const body = JSON.parse(reason);
    const error = body?.error ?? body;
    if (typeof error?.message === 'string') reason = [error.message, error.code, error.param].join(' ');
  } catch { /* 网关也会直接返回错误文本 */ }
  return [
    /unsupported media type|(?:invalid|unsupported)_(?:image|video)/i,
    /(?:invalid|unsupported|unrecognized|unexpected)\s+(?:input\s+)?(?:images?|videos?|mime|multimodal)\b(?!\s+model)/i,
    /(?:unsupported|invalid|unrecognized)\s+(?:(?:file|media)\s+)?format\b.{0,30}\b(?:image|video|gif|webp|png|jpeg)/i,
    /only (?:supports?|accepts?) (?:plain )?text (?:input|content|messages)|仅支持(?:纯)?文本输入/i,
    /(?:invalid|unsupported|unexpected)\b.{0,100}\b(?:image_url|video_url)\b/i,
    /(?:image_url|video_url|image\/\w+|video\/\w+|images?|videos?|gif|webp).{0,50}(?:not supported|unsupported|not allowed|invalid format|cannot be processed)/i,
    /(?:does not support|doesn't support|cannot process|cannot decode|only supports?).{0,40}(?:images?|videos?|gif|png|jpeg|multimodal)/i,
    /(?:图片|图像|视频|多模态|动图).{0,20}(?:不支持|无效|不合法|格式错误)|(?:不支持|无法解码|无法处理).{0,12}(?:图片|图像|视频|动图|多模态)/
  ].some((pattern) => pattern.test(reason));
}

const MAX_FRAME_BYTES = 12 * 1024 * 1024; // 与看图工具的下载上限一致。
const MAX_CONVERSIONS = 4;
const unavailableText = '【媒体读取失败】本项画面未能显示。请根据其余可见内容回答，勿猜测画面或重复获取同一附件。';

async function stillFrameParts(part, conversions, signal) {
  const url = part[part.type]?.url;
  const prefix = typeof url === 'string' && /^data:(?:image|video)\/[\w.+-]+;base64,/i.exec(url);
  // 外链交由原有下载工具校验；降级过程不另发网络请求。
  if (!prefix) return part.type === 'video_url' ? null : [part];
  const start = prefix[0].length;
  const header = Buffer.from(url.slice(start, start + 24), 'base64');
  const mime = detectImageType(header)?.mime;
  if (part.type === 'image_url' && (mime === 'image/jpeg' || mime === 'image/png')) return [part];
  const convertible = mime === 'image/gif' || mime === 'image/webp' || header.toString('ascii', 4, 8) === 'ftyp';
  if (!convertible || url.length - start > Math.ceil(MAX_FRAME_BYTES / 3) * 4) return null;
  // 历史消息中可能含有重复附件。限制一次请求触发的本地解码数。
  if (!conversions.has(url)) {
    if (conversions.size >= MAX_CONVERSIONS) return null;
    const png = await mediaFirstFrameDataUrl(Buffer.from(url.slice(start), 'base64'), signal);
    conversions.set(url, png);
  }
  const png = conversions.get(url);
  return png ? [
    { type: 'text', text: '以下为该附件的静态首帧，仅据此描述可见画面。' },
    { type: 'image_url', image_url: { url: png } }
  ] : null;
}

/** 对已被网关拒绝的媒体做一次转换。保留原消息次序、工具调用和文本。 */
export async function adaptMediaMessages(messages, mode, signal) {
  const conversions = new Map();
  let changed = false;
  const result = [];
  for (const message of messages) {
    if (message?.role !== 'user' || !Array.isArray(message.content) || !message.content.some(isMedia)) {
      result.push(message);
      continue;
    }
    const parts = [];
    let replaced = false;
    for (const part of message.content) {
      signal?.throwIfAborted();
      if (!isMedia(part)) {
        parts.push(part);
        continue;
      }
      const replacement = mode === 'text' ? null : await stillFrameParts(part, conversions, signal);
      if (replacement) parts.push(...replacement);
      else parts.push({ type: 'text', text: unavailableText });
      if (replacement?.[0] !== part) replaced = true;
    }
    if (replaced) {
      changed = true;
      const content = parts.every((p) => p.type === 'text') ? parts.map((p) => p.text).join('\n') : parts;
      result.push({ ...message, content });
    } else {
      result.push(message);
    }
  }
  return changed ? result : messages;
}
