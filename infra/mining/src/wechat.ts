import axios from "axios";
import FormData from "form-data";

export type WechatConfig = {
  appId: string;
  appSecret: string;
  proxyUrl: string;
};

export type WechatDraftReadback = {
  mediaId: string;
  title: string;
  content: string;
};

export function canonicalizeWechatDraftContent(value: string): string {
  return value.replace(/\r\n?/g, "\n").trim().replace(/<img\b[^>]*\/?\s*>/gi, tag => {
    const attributes = new Map<string, string>();
    for (const match of tag.matchAll(/([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(["'])(.*?)\2/g)) {
      attributes.set(match[1].toLowerCase(), match[3]);
    }
    const source = attributes.get("data-src") || attributes.get("src");
    if (!source) return tag;
    let normalizedSource = source;
    try {
      const url = new URL(source);
      if (/\/640$/.test(url.pathname)) url.pathname = url.pathname.replace(/\/640$/, "/0");
      normalizedSource = url.toString();
    } catch {
      return tag;
    }
    const alt = attributes.get("alt") || "";
    const style = attributes.get("style") || "";
    return `<img src="${normalizedSource}" alt="${alt}" style="${style}"/>`;
  });
}

/**
 * Gets a WeChat access token via the configured proxy
 */
export async function getAccessToken(config?: WechatConfig): Promise<string> {
  const wechat = resolveWechatConfig(config);
  const url = `${wechat.proxyUrl}/cgi-bin/token?grant_type=client_credential&appid=${wechat.appId}&secret=${wechat.appSecret}`;
  
  const response = await axios.get(url);
  const data = response.data;
  
  if (data.errcode && data.errcode !== 0) {
    throw new Error(`WeChat token error: ${data.errcode} - ${data.errmsg}`);
  }
  
  return data.access_token;
}

/**
 * Uploads a PNG/JPG buffer to WeChat to get a permanent media_id for the cover
 */
async function uploadCoverImage(accessToken: string, imageBuffer: Buffer, config?: WechatConfig): Promise<string> {
  const wechat = resolveWechatConfig(config);
  const url = `${wechat.proxyUrl}/cgi-bin/material/add_material?access_token=${accessToken}&type=image`;
  
  const form = new FormData();
  form.append("media", imageBuffer, { filename: "cover.png", contentType: "image/png" });
  
  const response = await axios.post(url, form, {
    headers: form.getHeaders()
  });
  
  if (response.data.errcode && response.data.errcode !== 0) {
    throw new Error(`WeChat cover upload error: ${response.data.errcode} - ${response.data.errmsg}`);
  }
  
  return response.data.media_id;
}

export async function uploadWechatArticleImage(accessToken: string, imageBuffer: Buffer, config?: WechatConfig): Promise<string> {
  const wechat = resolveWechatConfig(config);
  const url = `${wechat.proxyUrl}/cgi-bin/media/uploadimg?access_token=${accessToken}`;

  const form = new FormData();
  form.append("media", imageBuffer, { filename: "article-image.png", contentType: "image/png" });

  const response = await axios.post(url, form, {
    headers: form.getHeaders()
  });

  if (response.data.errcode && response.data.errcode !== 0) {
    throw new Error(`WeChat article image upload error: ${response.data.errcode} - ${response.data.errmsg}`);
  }

  if (!response.data.url) {
    throw new Error("WeChat article image upload did not return url");
  }

  return response.data.url;
}

function buildDraftArticle(title: string, content: string, thumbMediaId: string) {
  return {
    title,
    content,
    author: "VibePub",
    thumb_media_id: thumbMediaId,
    show_cover_pic: 0,
    need_open_comment: 1,
    only_fans_can_comment: 0,
  };
}

/**
 * Pushes a draft article to WeChat Official Account
 */
export async function publishDraft(
  accessToken: string,
  title: string,
  content: string,
  coverBuffer: Buffer,
  config?: WechatConfig,
): Promise<string> {
  console.log("Uploading AI generated cover to WeChat...");
  const thumbMediaId = await uploadCoverImage(accessToken, coverBuffer, config);
  const wechat = resolveWechatConfig(config);
  
  const url = `${wechat.proxyUrl}/cgi-bin/draft/add?access_token=${accessToken}`;
  
  // Format as WeChat FreePublish API expects
  const payload = {
    articles: [
      buildDraftArticle(title, content, thumbMediaId),
    ]
  };

  const response = await axios.post(url, payload);
  const data = response.data;
  
  if (data.errcode && data.errcode !== 0) {
    // 40007 means invalid media id, etc.
    throw new Error(`WeChat draft add error: ${data.errcode} - ${data.errmsg}`);
  }
  
  return data.media_id; // returns the draft media_id
}

/**
 * Updates the first article in an existing WeChat draft.
 */
export async function updateDraft(
  accessToken: string,
  mediaId: string,
  title: string,
  content: string,
  coverBuffer: Buffer,
  config?: WechatConfig,
): Promise<void> {
  console.log("Uploading revised cover to WeChat...");
  const thumbMediaId = await uploadCoverImage(accessToken, coverBuffer, config);
  const wechat = resolveWechatConfig(config);
  const url = `${wechat.proxyUrl}/cgi-bin/draft/update?access_token=${accessToken}`;
  const payload = {
    media_id: mediaId,
    index: 0,
    articles: buildDraftArticle(title, content, thumbMediaId),
  };

  const response = await axios.post(url, payload);
  const data = response.data;

  if (data.errcode && data.errcode !== 0) {
    throw new Error(`WeChat draft update error: ${data.errcode} - ${data.errmsg}`);
  }
}

export async function getDraftReadback(
  accessToken: string,
  mediaId: string,
  config?: WechatConfig,
): Promise<WechatDraftReadback> {
  const wechat = resolveWechatConfig(config);
  const url = `${wechat.proxyUrl}/cgi-bin/draft/get?access_token=${accessToken}`;
  const response = await axios.post(url, { media_id: mediaId });
  const data = response.data;
  if (data.errcode && data.errcode !== 0) {
    throw new Error(`WeChat draft readback error: ${data.errcode} - ${data.errmsg}`);
  }
  const article = Array.isArray(data.news_item) ? data.news_item[0] : undefined;
  if (!article || typeof article.title !== "string" || typeof article.content !== "string") {
    throw new Error("WeChat draft readback did not return one article");
  }
  return { mediaId, title: article.title, content: article.content };
}

function resolveWechatConfig(config?: WechatConfig): WechatConfig {
  const resolved = {
    appId: config?.appId || process.env.WECHAT_APP_ID || "",
    appSecret: config?.appSecret || process.env.WECHAT_APP_SECRET || "",
    proxyUrl: config?.proxyUrl || process.env.WECHAT_PROXY || "",
  };
  if (!resolved.appId || !resolved.appSecret || !resolved.proxyUrl) {
    throw new Error("WeChat publishing account is not configured");
  }
  return {
    ...resolved,
    proxyUrl: resolved.proxyUrl.replace(/\/+$/, ""),
  };
}
