import axios from "axios";
import FormData from "form-data";

const WECHAT_APP_ID = process.env.WECHAT_APP_ID!;
const WECHAT_APP_SECRET = process.env.WECHAT_APP_SECRET!;
const WECHAT_PROXY = process.env.WECHAT_PROXY!; // e.g. "http://23.105.194.173:8080"

/**
 * Gets a WeChat access token via the configured proxy
 */
export async function getAccessToken(): Promise<string> {
  const url = `${WECHAT_PROXY}/cgi-bin/token?grant_type=client_credential&appid=${WECHAT_APP_ID}&secret=${WECHAT_APP_SECRET}`;
  
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
async function uploadCoverImage(accessToken: string, imageBuffer: Buffer): Promise<string> {
  const url = `${WECHAT_PROXY}/cgi-bin/material/add_material?access_token=${accessToken}&type=image`;
  
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
export async function publishDraft(accessToken: string, title: string, content: string, coverBuffer: Buffer): Promise<string> {
  console.log("Uploading AI generated cover to WeChat...");
  const thumbMediaId = await uploadCoverImage(accessToken, coverBuffer);
  
  const url = `${WECHAT_PROXY}/cgi-bin/draft/add?access_token=${accessToken}`;
  
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
): Promise<void> {
  console.log("Uploading revised cover to WeChat...");
  const thumbMediaId = await uploadCoverImage(accessToken, coverBuffer);
  const url = `${WECHAT_PROXY}/cgi-bin/draft/update?access_token=${accessToken}`;
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
