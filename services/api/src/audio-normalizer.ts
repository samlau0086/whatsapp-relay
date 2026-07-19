import { spawn } from "node:child_process";

export type TranscriptionAudio={bytes:Buffer;fileName:string;mimeType:string};
type AudioConverter=(bytes:Buffer)=>Promise<Buffer>;

const SUPPORTED_EXTENSIONS=new Set(["mp3","mp4","mpeg","mpga","m4a","wav","webm"]);

export function needsTranscriptionConversion(fileName:string,mimeType:string):boolean{
  const extension=fileName.toLowerCase().split(".").pop()??"";
  if(SUPPORTED_EXTENSIONS.has(extension))return false;
  const mime=mimeType.toLowerCase().split(";",1)[0].trim();
  return !new Set(["audio/mpeg","audio/mp4","audio/x-m4a","audio/wav","audio/wave","audio/webm","video/mp4","video/webm"]).has(mime);
}

export async function normalizeTranscriptionAudio(input:TranscriptionAudio,convert:AudioConverter=convertToMp3):Promise<TranscriptionAudio>{
  if(!needsTranscriptionConversion(input.fileName,input.mimeType))return input;
  return{bytes:await convert(input.bytes),fileName:replaceExtension(input.fileName,"mp3"),mimeType:"audio/mpeg"};
}

async function convertToMp3(bytes:Buffer):Promise<Buffer>{
  return new Promise((resolve,reject)=>{
    const process=spawn("ffmpeg",["-hide_banner","-loglevel","error","-i","pipe:0","-vn","-ac","1","-ar","16000","-codec:a","libmp3lame","-b:a","64k","-f","mp3","pipe:1"],{stdio:["pipe","pipe","pipe"]});
    const output:Buffer[]=[];const errors:Buffer[]=[];
    process.stdout.on("data",chunk=>output.push(Buffer.from(chunk)));
    process.stderr.on("data",chunk=>errors.push(Buffer.from(chunk)));
    process.on("error",error=>reject(new Error(`audio_conversion_unavailable:${error.message}`)));
    process.on("close",code=>{const result=Buffer.concat(output);if(code!==0||!result.length)return reject(new Error(`audio_conversion_failed:${Buffer.concat(errors).toString("utf8").slice(0,300)}`));resolve(result);});
    process.stdin.on("error",()=>{});process.stdin.end(bytes);
  });
}

function replaceExtension(fileName:string,extension:string):string{
  const base=fileName.replace(/\.[^.]+$/u,"").trim()||"voice";return`${base}.${extension}`;
}
