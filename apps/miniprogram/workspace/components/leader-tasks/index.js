const layerBack=require('../../utils/layer-back');
const body=require('./body-controller');
const {data,onLoad,onUnload,...methods}=body;
Component(layerBack.component({
  properties:{active:Boolean,reduceMotion:Boolean},
  data:JSON.parse(JSON.stringify(data)),
  observers:{
    active(value){
      if(!this.panelAttached)return;
      if(!value){this.resetReportMenu();this.resetAssignmentMenu();this.resetGlassSegments();}
      else if(this.panelReady&&!this.data.executionLoading&&!this.data.reportPanel&&!this.data.assignmentPanel&&!this.data.productPanel&&!this.data.taskChooser&&!this.data.actionBusy)this.loadExecution();
    },
    'reportPanel, reportMenu, assignmentPanel, assignmentMenu, productPanel, imageViewer, taskChooser, actionBusy'(panel,menu,assignmentPanel,assignmentMenu,productPanel,imageViewer,chooser,busy){this.triggerEvent('modalchange',{modal:!!panel||!!menu||!!assignmentPanel||!!assignmentMenu||!!productPanel||!!imageViewer||!!chooser,sheet:!!panel||!!assignmentPanel||!!imageViewer,busy:!!busy});}
  },
  lifetimes:{
    attached(){this.panelAttached=true;this.setData({reduceMotion:this.properties.reduceMotion});this._loadPromise=Promise.resolve(onLoad.call(this)).finally(()=>{this.panelReady=true;});},
    detached(){this.panelAttached=false;onUnload.call(this);}
  },
  pageLifetimes:{show(){if(this.panelReady&&this.properties.active&&!this.data.reportPanel&&!this.data.assignmentPanel&&!this.data.productPanel&&!this.data.taskChooser&&!this.data.actionBusy)this.loadExecution();}},
  methods:{...methods,setupGlassNav(){},clearGlassNav(){}}
},'leader-tasks'));
