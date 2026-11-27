import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../',import.meta.url)),mini=path.join(root,'apps/miniprogram'),workspace=path.join(mini,'workspace'),out=path.join(root,'artifacts/workspace-native');
const compiler='D:/app/微信web开发者工具/code/package.nw/node_modules/wcc-exec/';fs.mkdirSync(out,{recursive:true});
function files(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?files(path.join(dir,entry.name)):[path.join(dir,entry.name)]);}
const all=files(workspace),templates=all.filter(file=>file.endsWith('.wxml')).map(file=>path.relative(workspace,file).replaceAll('\\','/'));
for(const file of all.filter(file=>file.endsWith('.js'))){execFileSync(process.execPath,['--check',file]);const content=fs.readFileSync(file,'utf8');assert(!/reference-test|reference-goods|90001|fixtureExecution|测试刀模/.test(content),'Demo data in native bundle: '+file);}
for(const file of all.filter(file=>file.endsWith('.json'))){const config=JSON.parse(fs.readFileSync(file,'utf8'));for(const component of Object.values(config.usingComponents||{}))assert(fs.existsSync(path.join(mini,component+'.json')),'Missing component: '+component);}
function css(file,output){
 const deps=new Set();const visit=current=>{for(const match of fs.readFileSync(path.join(workspace,current),'utf8').matchAll(/@import\s+["']([^"']+)["']/g)){const target=path.posix.normalize(path.posix.join(path.posix.dirname(current),match[1]));if(!deps.has(target)){deps.add(target);visit(target);}}};visit(file);
 execFileSync(compiler+'wcsc.exe',['-o',path.join(out,output+'.native-bundle'),'-pc','1',file,...deps],{cwd:workspace});
 const flatten=current=>fs.readFileSync(path.join(workspace,current),'utf8').replace(/@import\s+["']([^"']+)["'];/g,(_,relative)=>flatten(path.posix.normalize(path.posix.join(path.posix.dirname(current),relative))));
 const flat=output+'.flat.wxss';fs.writeFileSync(path.join(out,flat),flatten(file));execFileSync(compiler+'wcsc.exe',['-o',path.join(out,output),flat],{cwd:out});
}
for(const name of ['orders','tasks','details','dispatch','worker']){execFileSync(compiler+'wcc.exe',['-o',path.join(out,name+'-wxml.js'),...templates],{cwd:workspace});css('pages/'+name+'/'+name+'.wxss',name+'-wxss.js');}
css('base.wxss','app-wxss.js');css('components/liquid-detail/index.wxss','liquid-wxss.js');css('components/leader-tasks/index.wxss','leader-tasks-wxss.js');css('components/reports-dashboard/index.wxss','reports-dashboard-wxss.js');
const size=all.reduce((sum,file)=>sum+fs.statSync(file).size,0),result={nativeTemplatesAndStyles:'compiled',jsFiles:all.filter(f=>f.endsWith('.js')).length,templateFiles:templates.length,workspaceBytes:size,demoDataInNativeBundle:false,productionUploaded:false,wechatDeviceAcceptance:'pending'};
fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
