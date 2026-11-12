import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, symlink, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMediaFilesystemTools, parseSrt, registerMediaFilesystemTools, runMediaCommand } from './media-filesystem.js';

const root=await mkdtemp(path.join(os.tmpdir(),'media-filesystem-'));
try {
  const media=path.join(root,'media'), outside=path.join(root,'outside');
  await mkdir(media); await mkdir(outside);
  const file=path.join(media,'episode.mkv'), srt=path.join(media,'episode.srt'), ref=path.join(media,'reference.srt');
  await writeFile(file,'media fixture');
  const original='1\n00:00:01,000 --> 00:00:02,500\nFirst cue\n\n2\n00:00:03,000 --> 00:00:04,000\nSecond cue\n';
  await writeFile(srt,original); await writeFile(ref,original);
  await writeFile(path.join(outside,'secret.srt'),original);
  await symlink(outside,path.join(media,'escape'));
  const commands=[];
  let commandFailure=false, badDuration=false, changeSource=false, loseForced=false;
  const metadata={format:{duration:'10'},streams:[{index:0,codec_type:'video',codec_name:'h264'},{index:1,codec_type:'audio',codec_name:'aac',disposition:{default:0}},{index:2,codec_type:'subtitle',codec_name:'subrip',disposition:{forced:1,hearing_impaired:1}}]};
  const deps={roots:[media],pathMaps:[{source:'/tv',target:media}],readCandidates:value=>[value.replace(/^\/tv(?=\/|$)/,media)],readTarget:async value=>{
    const resolved=value.replace(/^\/tv(?=\/|$)/,media);
    const info=await stat(resolved).catch(()=>null);
    return info?{path:resolved,info}:{path:null,blockers:[{message:'Unavailable file'}]};
  },plexFile:async input=>input.ratingKey==='episode'?file:null,findExecutable:async names=>names[0],timeoutMs:1000,runCommand:async(executable,args)=>{
    commands.push({executable,args});
    if(executable==='ffprobe') {
      const output=args.at(-1).endsWith('copy.mkv');
      return {code:0,stdout:JSON.stringify(output?{...metadata,format:{duration:badDuration?'2':'10'},streams:[metadata.streams[0],{...metadata.streams[1],codec_name:'ac3',disposition:{default:1}},{...metadata.streams[2],disposition:{default:1,forced:loseForced?0:1,hearing_impaired:1}}]}:metadata),stderr:''};
    }
    if(commandFailure) return {code:null,stdout:'',stderr:'',error:'Media command timed out'};
    if(args.at(-1)!=='-') await writeFile(args.at(-1),'verified remux fixture');
    if(changeSource) await writeFile(file,'concurrent replacement of source');
    return {code:0,stdout:'',stderr:''};
  },jsonText:value=>value};
  const tools=createMediaFilesystemTools(deps);
  assert.equal((await tools.pathStatus({path:'/tv/episode.mkv'})).path,file);
  assert.equal((await tools.pathStatus({})).configured,true);
  const listed=await tools.listFiles({path:'/tv',limit:100,depth:2});
  assert.equal(listed.records.length,3);
  assert.ok(listed.records.every(item=>!item.path.includes('secret')));
  assert.equal((await tools.listFiles({path:'/tv',limit:1,depth:1})).truncated,true);
  await assert.rejects(()=>tools.listFiles({path:outside,limit:10,depth:1}),/No readable directory/);
  await assert.rejects(()=>tools.decode({path:path.join(media,'escape','secret.srt'),startSeconds:0,durationSeconds:2}),/outside/);
  assert.equal((await tools.decode({ratingKey:'episode',startSeconds:2,durationSeconds:3})).decoded,true);
  assert.equal(commands.at(-1).args.includes('-xerror'),true);
  for(const call of commands) {
    assert.equal(call.args[call.args.indexOf('-protocol_whitelist')+1],'file');
    const formats=call.args[call.args.indexOf('-format_whitelist')+1].split(',');
    assert.ok(formats.includes('matroska'));
    assert.ok(!formats.includes('hls')&&!formats.includes('concat'));
  }
  await assert.rejects(()=>tools.decode({path:file,startSeconds:12,durationSeconds:2}),/outside/);
  commandFailure=true;
  assert.equal((await tools.decode({path:file,startSeconds:0,durationSeconds:2})).decoded,false);
  commandFailure=false;

  const timing=await tools.subtitleSync({path:srt,referencePath:ref,limit:1,toleranceMs:100});
  assert.equal(timing.reference.timingsAligned,true);
  assert.equal(timing.synchronizationVerified,false);
  assert.equal(timing.truncated,true);
  assert.ok(!JSON.stringify(timing).includes('First cue'));
  assert.throws(()=>parseSrt('1\n00:61:00,000 --> 00:62:00,000\nBad'),/timestamp/);
  assert.throws(()=>parseSrt('1\n00:00:02,000 --> 00:00:01,000\nBad'),/before/);
  const plan=await tools.retime({path:srt,offsetMs:500,dryRun:true,replaceOriginal:false});
  assert.equal(plan.written,false);
  await assert.rejects(()=>tools.retime({path:srt,offsetMs:500,dryRun:false}),/expectedSha256/);
  const shifted=await tools.retime({path:srt,offsetMs:500,dryRun:false,expectedSha256:plan.sha256});
  assert.equal(shifted.written,true);
  assert.equal(await readFile(srt,'utf8'),original);
  assert.equal(parseSrt(await readFile(shifted.outputPath,'utf8'))[0].startMs,1500);
  await assert.rejects(()=>tools.retime({path:srt,offsetMs:100,dryRun:false,expectedSha256:plan.sha256}),/EEXIST/);
  await assert.rejects(()=>tools.retime({path:srt,offsetMs:-2000,dryRun:true}),/outside/);
  const replacement=await tools.retime({path:srt,offsetMs:250,replaceOriginal:true,dryRun:false,expectedSha256:plan.sha256});
  assert.equal(await readFile(replacement.backupPath,'utf8'),original);
  assert.equal(parseSrt(await readFile(srt,'utf8'))[0].startMs,1250);
  await assert.rejects(()=>tools.retime({path:srt,offsetMs:250,replaceOriginal:true,dryRun:false,expectedSha256:plan.sha256}),/expectedSha256/);

  const remuxPlan=await tools.remux({path:file,audioStreamIndex:1,subtitleStreamIndex:2,audioCodec:'copy',timeoutSeconds:2,dryRun:true});
  assert.equal(remuxPlan.created,false);
  await assert.rejects(()=>tools.remux({path:file,audioCodec:'copy',timeoutSeconds:2,dryRun:false}),/expectedSourceSignature/);
  await assert.rejects(()=>tools.remux({path:file,audioStreamIndex:99,dryRun:true}),/does not belong/);
  commandFailure=true;
  await assert.rejects(()=>tools.remux({path:file,audioCodec:'copy',timeoutSeconds:2,dryRun:false,expectedSourceSignature:remuxPlan.sourceSignature}),/timed out/);
  commandFailure=false;badDuration=true;
  await assert.rejects(()=>tools.remux({path:file,audioCodec:'copy',timeoutSeconds:2,dryRun:false,expectedSourceSignature:remuxPlan.sourceSignature}),/verification/);
  badDuration=false;loseForced=true;
  await assert.rejects(()=>tools.remux({path:file,audioCodec:'ac3',audioStreamIndex:1,subtitleStreamIndex:2,timeoutSeconds:2,dryRun:false,expectedSourceSignature:remuxPlan.sourceSignature}),/unrelated stream disposition/);
  loseForced=false;changeSource=true;
  await assert.rejects(()=>tools.remux({path:file,audioCodec:'ac3',audioStreamIndex:1,subtitleStreamIndex:2,timeoutSeconds:2,dryRun:false,expectedSourceSignature:remuxPlan.sourceSignature}),/Source changed/);
  changeSource=false;await writeFile(file,'media fixture');
  remuxPlan.sourceSignature=(await tools.remux({path:file,audioCodec:'copy',dryRun:true})).sourceSignature;
  const copied=await tools.remux({path:file,audioStreamIndex:1,subtitleStreamIndex:2,audioCodec:'ac3',timeoutSeconds:2,dryRun:false,expectedSourceSignature:remuxPlan.sourceSignature});
  assert.equal(copied.created,true);assert.equal(copied.playbackVerified,false);
  assert.equal(await readFile(file,'utf8'),'media fixture');
  assert.equal(await readFile(copied.outputPath,'utf8'),'verified remux fixture');
  assert.ok(commands.some(c=>c.args.includes('-disposition:a:0')&&c.args.includes('+default')));
  await assert.rejects(()=>tools.remux({path:file,audioCodec:'copy',timeoutSeconds:2,dryRun:false,expectedSourceSignature:remuxPlan.sourceSignature}),/EEXIST/);
  assert.ok(!(await readdir(media)).some(name=>name.startsWith('.media-mcp-')));

  const registered=[];
  registerMediaFilesystemTools({registerTool:(name,config,fn)=>registered.push({name,config,fn})},deps);
  assert.equal(registered.length,6);
  for(const name of ['media_retime_subtitle_sidecar','media_remux_compatibility_copy']) {
    const tool=registered.find(t=>t.name===name);
    assert.equal(tool.config.annotations.destructiveHint,true);
    assert.equal(tool.config.inputSchema.dryRun.parse(undefined),true);
  }
  const runaway=await runMediaCommand(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],undefined,{timeoutMs:100});
  assert.equal(runaway.code,null);assert.match(runaway.error,/timed out/);
  const missing=await runMediaCommand('/not/a/command',[],undefined,{timeoutMs:100});
  assert.equal(missing.code,null);assert.match(missing.error,/ENOENT/);
  console.log('Media filesystem capability tests passed');
} finally {await rm(root,{recursive:true,force:true});}
