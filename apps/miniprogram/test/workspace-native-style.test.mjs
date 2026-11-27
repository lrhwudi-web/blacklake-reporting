import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {prepareButtons,prepareScrollViews,promoteButtonSelectors} from '../../../scripts/workspace-native-style.mjs';

test('原生按钮准备保留含比较符的事件/条件、既有size与动态class，不误改内容',()=>{
 const classes=new Set(),out=prepareButtons('<button class="scan {{open ? \'active\' : \'\'}}" disabled="{{n > 0}}">扫码</button><button size="mini">关闭</button>',classes);
 assert.match(out,/size="mini" class="native-button scan/);assert.match(out,/disabled="\{\{n > 0\}\}"/);assert.equal((out.match(/size="mini"/g)||[]).length,2);assert(classes.has('scan'));assert(!classes.has('open'));assert(classes.has('native-button'));
});

test('原生样式统一提升作者类选择器，保留数值、资源路径和媒体条件',()=>{
 const source='@import "./foo.wxss";\n.scan{width:68px;opacity:.75;background:url("/assets/scan.png")}@media(max-width:350px){.scan:hover,.card .scan{padding:.5px}}';
 const out=promoteButtonSelectors(source,new Set(['scan']));
 assert.match(out,/\.scan\.scan\{width:68px/);assert.match(out,/\.scan\.scan:hover,\.card\.card \.scan\.scan/);assert.match(out,/opacity:\.75/);assert.match(out,/url\("\/assets\/scan.png"\)/);assert.match(out,/@media\(max-width:350px\)/);assert.match(out,/@import "\.\/foo.wxss"/);
});

test('原工程全部按钮包括正式退出/绣花入口均使用原生尺寸重置',()=>{
 const root=fileURLToPath(new URL('../workspace/',import.meta.url));
 const files=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.join(dir,e.name)):[path.join(dir,e.name)]);
 let count=0;for(const file of files(root).filter(f=>f.endsWith('.wxml'))){
  for(const tag of fs.readFileSync(file,'utf8').matchAll(/<button\b(?:[^>"']|"[^"]*"|'[^']*')*>/g)){
   count++;assert.match(tag[0],/size="mini"/,file);assert.match(tag[0],/class="native-button(?: |")/,file);
  }
 }
 assert(count>100);
});

test('动态保存/危险操作和父级规则保持作者样式优先级，不被原生按钮reset覆盖',()=>{
 const out=promoteButtonSelectors('.report-save{background:blue}.report-danger{color:red}.footer button{padding:12px}');
 assert.match(out,/\.report-save\.report-save/);assert.match(out,/\.report-danger\.report-danger/);assert.match(out,/\.footer\.footer button/);
});

test('原生滚动区域使用增强模式和明确布尔false，保留滚动事件及比较符',()=>{
 const out=prepareScrollViews('<scroll-view class="body" scroll-y="{{count > 0}}" show-scrollbar="false" bindscroll="onScroll"/><scroll-view scroll-x="true"/>');
 assert.equal((out.match(/enhanced="\{\{true\}\}"/g)||[]).length,2);assert.equal((out.match(/show-scrollbar="\{\{false\}\}"/g)||[]).length,2);assert.match(out,/scroll-y="\{\{count > 0\}\}"/);assert.match(out,/bindscroll="onScroll"/);
});
