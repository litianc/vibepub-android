import axios from "axios";

const WECHAT_APP_ID = process.env.WECHAT_APP_ID!;
const WECHAT_APP_SECRET = process.env.WECHAT_APP_SECRET!;
const WECHAT_PROXY = process.env.WECHAT_PROXY!;

async function checkLatestDraft() {
  console.log("Fetching WeChat access token...");
  const tokenUrl = `${WECHAT_PROXY}/cgi-bin/token?grant_type=client_credential&appid=${WECHAT_APP_ID}&secret=${WECHAT_APP_SECRET}`;
  
  const tokenResponse = await axios.get(tokenUrl);
  const tokenData = tokenResponse.data;
  
  if (tokenData.errcode && tokenData.errcode !== 0) {
    throw new Error(`Token error: ${tokenData.errmsg}`);
  }
  
  const accessToken = tokenData.access_token;
  console.log("Got access token. Fetching latest draft...");
  
  const draftUrl = `${WECHAT_PROXY}/cgi-bin/draft/batchget?access_token=${accessToken}`;
  const response = await axios.post(draftUrl, {
    offset: 0,
    count: 1,
    no_content: 1
  });
  
  const data = response.data;
  if (data.errcode && data.errcode !== 0) {
    throw new Error(`Draft fetch error: ${data.errmsg}`);
  }
  
  if (data.item && data.item.length > 0) {
    const latest = data.item[0];
    const article = latest.content.news_item[0];
    console.log("==========================================");
    console.log("✅ SUCCESS: Found latest WeChat Draft");
    console.log(`Title: ${article.title}`);
    console.log(`Update Time: ${new Date(latest.update_time * 1000).toLocaleString()}`);
    console.log(`Media ID: ${latest.media_id}`);
    console.log("==========================================");
    
    console.log(`Deleting draft with media_id: ${latest.media_id}...`);
    const deleteUrl = `${WECHAT_PROXY}/cgi-bin/draft/delete?access_token=${accessToken}`;
    const deleteResponse = await axios.post(deleteUrl, { media_id: latest.media_id });
    
    if (deleteResponse.data.errcode && deleteResponse.data.errcode !== 0) {
      throw new Error(`Draft delete error: ${deleteResponse.data.errmsg}`);
    }
    
    console.log("✅ SUCCESS: Test draft deleted successfully from WeChat!");
  } else {
    console.log("No drafts found in the WeChat account.");
  }
}

checkLatestDraft().catch(console.error);
