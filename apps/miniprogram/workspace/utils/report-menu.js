// Viewport coordinates from the actual trigger; no assumed row position.
function layout(anchor, viewport, count, card = null) {
  const values=[anchor?.left,anchor?.top,anchor?.width,anchor?.height,viewport?.windowWidth,viewport?.windowHeight];
  if(!values.every(Number.isFinite)||anchor.width<=0||anchor.height<=0||viewport.windowWidth<200||viewport.windowHeight<160||![1,2,3,4,5].includes(count))return null;
  const width=166,height=count*44+10,inset=12,gap=10;
  if(viewport.windowHeight<height+inset*2||anchor.top+anchor.height<=0||anchor.top>=viewport.windowHeight||anchor.left+anchor.width<=0||anchor.left>=viewport.windowWidth)return null;
  if(card&&(![card.left,card.top,card.width,card.height].every(Number.isFinite)||card.width<=0||card.height<=0))return null;
  if(!card&&viewport.windowWidth<360){
    const above=anchor.top-height-gap>=inset,side=above?'bottom':'top';
    const x=Math.max(inset,Math.min(viewport.windowWidth-width-inset,anchor.left+anchor.width-width));
    const y=Math.max(inset,Math.min(viewport.windowHeight-height-inset,above?anchor.top-height-gap:anchor.top+anchor.height+gap));
    const arrowX=Math.max(18,Math.min(width-18,anchor.left+anchor.width/2-x));
    return {x,y,width,height,side,arrowX,originX:arrowX,originY:above?height:0,arrowStyle:'left:'+(arrowX-6)+'px;'+(above?'bottom':'top')+':-5px'};
  }
  const fitsLeft=anchor.left-width-gap>=inset,side=fitsLeft?'right':'left';
  const preferredX=fitsLeft?anchor.left-width-gap:anchor.left+anchor.width+gap;
  const x=Math.max(inset,Math.min(viewport.windowWidth-width-inset,preferredX));
  const y=Math.max(inset,Math.min(viewport.windowHeight-height-inset,card?card.top:anchor.top+anchor.height-height+4));
  const arrowY=Math.max(18,Math.min(height-18,anchor.top+anchor.height/2-y));
  return {x,y,width,height,arrowY,side,originX:fitsLeft?width:0,originY:arrowY,arrowStyle:'top:'+(arrowY-6)+'px'};
}
module.exports={layout};
