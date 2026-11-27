const DURATION = 280;
function layout(origin, width, height) {
  const w = Number.isFinite(width) && width >= 240 ? width : 390;
  const h = Number.isFinite(height) && height >= 240 ? height : 740;
  const panelWidth = Math.min(520, w - 24), panelHeight = h - 24;
  const x = (w - panelWidth) / 2, y = 12;
  const valid = origin && ['left', 'top', 'width', 'height'].every(key => Number.isFinite(origin[key])) && origin.width > 0 && origin.height > 0;
  const source = valid ? origin : { left: 16, top: Math.min(160, h / 4), width: w - 32, height: Math.min(260, h / 2) };
  const sx = source.width / panelWidth, sy = source.height / panelHeight;
  return { panelX: x, panelY: y, panelWidth, panelHeight,
    closedTransform: `translate3d(${source.left - x}px,${source.top - y}px,0) scale(${sx},${sy})`,
    openTransform: 'translate3d(0,0,0) scale(1,1)',
    closedRadius: `${20 / sx}px / ${20 / sy}px` };
}
function morph(origin,panel,sourceRadius=14){
  const valid=rect=>rect&&['left','top','width','height'].every(key=>Number.isFinite(rect[key]))&&rect.width>0&&rect.height>0;
  if(!valid(origin)||!valid(panel))return null;
  const sx=origin.width/panel.width,sy=origin.height/panel.height;
  return {left:panel.left,top:panel.top,width:panel.width,height:panel.height,
    boxStyle:`left:${panel.left}px;top:${panel.top}px;width:${panel.width}px;height:${panel.height}px;`,
    closedTransform:`translate3d(${origin.left-panel.left}px,${origin.top-panel.top}px,0) scale(${sx},${sy})`,
    openTransform:'translate3d(0,0,0) scale(1,1)',closedRadius:`${sourceRadius/sx}px / ${sourceRadius/sy}px`,
    closedClip:`inset(${origin.top-panel.top}px ${panel.left+panel.width-origin.left-origin.width}px ${panel.top+panel.height-origin.top-origin.height}px ${origin.left-panel.left}px round ${sourceRadius}px)`};
}
module.exports = { layout, morph, DURATION };
