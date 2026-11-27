// style:v2 native buttons use attribute selectors (width 184px, mini font and
// padding). Repeat author classes to win that cascade, including in isolated
// components where tag/attribute selectors are forbidden by WeChat.
export const nativeButtonReset='.native-button.native-button{display:block;box-sizing:border-box;padding:0;margin:0;border:0;border-radius:0;background:transparent;font:inherit;color:inherit;line-height:inherit;min-width:0}.native-button.native-button::after{border:0}.native-button.native-button.nav-item[disabled]{background:transparent;color:#53657C}';

export function prepareButtons(wxml,classes){
 let out='',cursor=0;const tag=/<button(?=[\s/>])/g;let match;
 while((match=tag.exec(wxml))){
  let i=match.index+match[0].length,quote='';
  for(;i<wxml.length;i++){const c=wxml[i];if(quote){if(c===quote)quote='';}else if(c==='"'||c==="'")quote=c;else if(c==='>')break;}
  let opening=wxml.slice(match.index,i+1);
  const classAttr=opening.match(/\sclass=(['"])([\s\S]*?)\1/);
  if(classAttr){
   for(const name of classAttr[2].replace(/\{\{[\s\S]*?\}\}/g,'').split(/\s+/))if(name)classes.add(name);
   opening=opening.replace(classAttr[0],' class='+classAttr[1]+'native-button '+classAttr[2]+classAttr[1]);
  }else opening=opening.replace('<button','<button class="native-button"');
  if(!/\ssize=/.test(opening))opening=opening.replace('<button','<button size="mini"');
  out+=wxml.slice(cursor,match.index)+opening;cursor=i+1;tag.lastIndex=cursor;
 }
 classes.add('native-button');return out+wxml.slice(cursor);
}

export function promoteButtonSelectors(css){
 let boundary=0,quote='',comment=false;const replacements=[];
 for(let i=0;i<css.length;i++){
  const c=css[i],next=css[i+1];
  if(comment){if(c==='*'&&next==='/'){comment=false;i++;}continue;}
  if(quote){if(c==='\\'){i++;continue;}if(c===quote)quote='';continue;}
  if(c==='/'&&next==='*'){comment=true;i++;continue;}
  if(c==='"'||c==="'"){quote=c;continue;}
  if(c==='{'){
   const selector=css.slice(boundary,i),clean=selector.replace(/\/\*[\s\S]*?\*\//g,'').trim();
   // Promote every author class uniformly: dynamic action classes and ancestor
   // selectors must retain their original precedence over the native reset.
   if(!clean.startsWith('@'))replacements.push({start:boundary,end:i,value:selector.replace(/\.([_a-zA-Z-][\w-]*)/g,full=>full+full)});
   boundary=i+1;
  }else if(c==='}'||c===';')boundary=i+1;
 }
 let out='',cursor=0;for(const r of replacements){out+=css.slice(cursor,r.start)+r.value;cursor=r.end;}return out+css.slice(cursor);
}

export function prepareScrollViews(wxml){
 let out='',cursor=0;const tag=/<scroll-view(?=[\s/>])/g;let match;
 while((match=tag.exec(wxml))){
  let i=match.index+match[0].length,quote='';for(;i<wxml.length;i++){const c=wxml[i];if(quote){if(c===quote)quote='';}else if(c==='"'||c==="'")quote=c;else if(c==='>')break;}
  let opening=wxml.slice(match.index,i+1);
  if(!/\sshow-scrollbar=/.test(opening))opening=opening.replace('<scroll-view','<scroll-view show-scrollbar="{{false}}"');
  else opening=opening.replace(/\sshow-scrollbar=(['"])false\1/,' show-scrollbar="{{false}}"');
  if(!/\senhanced=/.test(opening))opening=opening.replace('<scroll-view','<scroll-view enhanced="{{true}}"');
  out+=wxml.slice(cursor,match.index)+opening;cursor=i+1;tag.lastIndex=cursor;
 }
 return out+wxml.slice(cursor);
}
