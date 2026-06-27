import axios from "axios";
import { randomUUID } from "crypto";

const VOLC_ASR_APPID = process.env.VOLC_ASR_APPID!;
const VOLC_ASR_ACCESS_TOKEN = process.env.VOLC_ASR_ACCESS_TOKEN!;

export async function transcribeAudio(audioBuffer: Buffer, format: string = 'm4a'): Promise<string> {
  const url = "https://openspeech.bytedance.com/api/v1/asr";
  
  const payload = {
    app: {
      appid: VOLC_ASR_APPID,
      token: VOLC_ASR_ACCESS_TOKEN,
      cluster: "volcengine_input_common"
    },
    user: {
      uid: "vibepub_user"
    },
    audio: {
      format: format.toLowerCase().replace('.', ''), // e.g. "mp3", "m4a", "wav"
      rate: 16000,
      language: "zh-CN",
      bits: 16,
      channel: 1,
      codec: "raw"
    },
    request: {
      reqid: randomUUID(),
      text: "",
      sequence: 1,
      action: 1
    },
    payload: audioBuffer.toString('base64')
  };

  const response = await axios.post(url, payload, {
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer; ${VOLC_ASR_ACCESS_TOKEN}`
    }
  });

  const data = response.data;
  
  if (data.code !== 1000) {
    throw new Error(`Volcengine ASR failed: ${data.code} - ${data.message}`);
  }
  
  // The API returns the transcription in the 'result' field
  const results = data.result || [];
  return results.map((r: any) => r.text).join(' ');
}
