import { spawn } from "node:child_process";

export const BROWSER_VIDEO_MIME='video/mp4; codecs="avc1.4D401F, mp4a.40.2"';

export type BrowserVideo={bytes:Buffer;fileName:string;mimeType:string};
type VideoConverter=(bytes:Buffer)=>Promise<Buffer>;

export function isBrowserCompatibleVideo(mimeType:string):boolean{
  return mimeType.toLowerCase().startsWith("video/mp4")&&/\bcodecs\s*=/i.test(mimeType);
}

export async function normalizeBrowserVideo(input:BrowserVideo,convert:VideoConverter=convertToBrowserMp4):Promise<BrowserVideo>{
  if(isBrowserCompatibleVideo(input.mimeType))return input;
  return{bytes:await convert(input.bytes),fileName:replaceExtension(input.fileName,"mp4"),mimeType:BROWSER_VIDEO_MIME};
}

async function convertToBrowserMp4(bytes:Buffer):Promise<Buffer>{
  return new Promise((resolve,reject)=>{
    const process=spawn("ffmpeg",[
      "-hide_banner","-loglevel","error","-i","pipe:0",
      "-map","0:v:0","-map","0:a:0?",
      "-vf","pad=ceil(iw/2)*2:ceil(ih/2)*2",
      "-c:v","libx264","-preset","veryfast","-crf","23","-pix_fmt","yuv420p","-profile:v","main","-level","4.0",
      "-c:a","aac","-b:a","128k",
      "-movflags","frag_keyframe+empty_moov+default_base_moof","-f","mp4","pipe:1"
    ],{stdio:["pipe","pipe","pipe"]});
    const output:Buffer[]=[];const errors:Buffer[]=[];
    process.stdout.on("data",chunk=>output.push(Buffer.from(chunk)));
    process.stderr.on("data",chunk=>errors.push(Buffer.from(chunk)));
    process.on("error",error=>reject(new Error(`video_conversion_unavailable:${error.message}`)));
    process.on("close",code=>{const result=Buffer.concat(output);if(code!==0||!result.length)return reject(new Error(`video_conversion_failed:${Buffer.concat(errors).toString("utf8").slice(0,300)}`));resolve(result);});
    process.stdin.on("error",()=>{});process.stdin.end(bytes);
  });
}

function replaceExtension(fileName:string,extension:string):string{
  const base=fileName.replace(/\.[^.]+$/u,"").trim()||"video";return`${base}.${extension}`;
}
