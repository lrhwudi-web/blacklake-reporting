const layerBack=require('../../utils/layer-back');
const formal=require('../../utils/live-workspace');
// Live reads use the new adapter. Order writes require the isolated local preview adapter.
const api = require('../../utils/api');
const glassNav = require('../../utils/glass-navigation');
const photo = require('../../utils/glass-image-viewer');
const segments = require('../../utils/glass-segments');
const workspace = require('../../utils/workspace-tabs');
const orderOperations = require('../../utils/order-operations');
const clockout = require('../../utils/clockout');
const listTools = require('../../utils/order-list-tools');
const orderTime=require('../../utils/order-time');
const orderListRefresh=require('../../utils/order-list-refresh');
function searchText(value) {
  if(typeof value!=='string'&&typeof value!=='number')return '';
  return String(value).replace(/[\uFF01-\uFF5E]/g,char=>String.fromCharCode(char.charCodeAt(0)-65248))
    .toLowerCase().replace(/[\s\-_/|.,:;#()[\]{}，。、：；（）【】－—–·]+/g,'');
}
function matchesSearch(order,terms) {
  const fields=[order.code,order.title,order.product,order.productCode,order.productName,order.productSpecification].map(searchText).filter(Boolean);
  return terms.every(term=>fields.some(field=>field.includes(term)));
}
const records = [];
function presentCard(order, previous) {
  const waiting = !order.processesLoaded || order.sync?.complete === false && !order.processes?.length;
  const pending = waiting && order.sync?.pending === true;
  return { ...order, ...orderTime.remaining(order), processesLoaded: !waiting,
    processesLoading: pending, processesError: waiting && order.sync?.paused === true,
    ...(previous?.imageFailed && previous.imageUrl === order.imageUrl ? { imageFailed: true } : {}) };
}

Page(formal.wrap(layerBack.page({
  ...segments.methods,...workspace.methods,...orderOperations.methods,...clockout.methods,...listTools.methods,
  data: {
    ...glassNav.data, ...photo.data, ...segments.data,...workspace.data,...orderOperations.data,...clockout.data,...listTools.data,
    activeStatus: "ALL", searchOpen: false, keyword: "", orders: records, snapshotOrders: records,
    detailMounted: false, detailVisible: false, detailOrigin: null, detailOrderId: '', detailProcessId: '', reduceMotion: false,
    sourceMode: 'reference-snapshot', loading: false, loadError: '', sourceNote: '', hasMore: false, canDispatch: false,
    loadedOrders: [], pageNum: 0, queryCode: '', ordersTotal:null,
    totalLabel: "尚未读取", activePanel: "", selectedOrder: null,
    statuses: [
      { key: "ALL", label: "全部" },
      { key: "NOT_STARTED", label: "未开始 25" },
      { key: "IN_PROGRESS", label: "执行中 365" },
      // Remaining digits are clipped in the reference; never infer the count.
      { key: "FINISHED", label: "已结束 64…" }
    ]
  },
  onLoad(options={}) {
    this.setupWorkspace?.(options);
    this.setupGlassSegments?.();
    this.setupGlassNav?.();
    this.setupOrderOperationMotion?.();
    this.syncOrderListOwner?.();
    this.setData({ canDispatch: getApp().globalData.entry?.appRole === 'floor8_leader' });
    if (getApp().globalData.dataMode === 'live') {
      this.setData({ sourceMode: 'live', orders: [], totalLabel: '正在读取工单…',
        statuses: [{ key: 'ALL', label: '全部' }, { key: 'NOT_STARTED', label: '未开始' }, { key: 'IN_PROGRESS', label: '执行中' }, { key: 'FINISHED', label: '已结束' }] });
      this._loadPromise = this.loadLive();
    }else this._operationsPromise=this.refreshOrderOperationStates?.();
  },
  onShow(){this.orderOperationPageHidden=false;this.restoreAfterDispatch();this.syncOrderListOwner?.();this.refreshOrderOperationStates?.();if(this.data.operationPanel?.checking)this.reloadOrderOperations?.({poll:true});},
  onHide(){this.orderOperationPageHidden=true;this.stopOrderOperationPolling?.();},
  restoreAfterDispatch(){
    const app=getApp();if(!app.globalData.dispatchReturnToOrders)return;
    delete app.globalData.dispatchReturnToOrders;
    this.cancelGlassNav?.();
    this.setData({detailMounted:false,detailVisible:false,detailOrderId:'',detailOrigin:null,workspaceTab:0,workspaceInstant:true,navActiveIndex:0,navHover:0});
    this.measureGlassNav?.();
  },
  openDispatch(event) {
    if(this.data.operationPanel||this.data.clockoutPanel||this.data.listPanel)return;
    if (getApp().globalData.entry?.appRole !== 'floor8_leader') return;
    const id = String(event.currentTarget.dataset.id);
    const order = this.data.orders.find(row => String(row.id) === id);
    if (!order || !['NOT_STARTED', 'IN_PROGRESS'].includes(order.status)) return;
    if (!Number.isSafeInteger(order.id) && !getApp().globalData.uiPreview) return;
    getApp().globalData.dispatchOrder = { ...order };
    getApp().globalData.dispatchPreferredProcess = null;
    wx.navigateTo({ url: '/workspace/pages/dispatch/dispatch?projectId=' + encodeURIComponent(id) });
  },
  openOrder(event) {
    this.cancelGlassNav?.();
    if (this.openingDetail || this.data.detailMounted || this.data.clockoutPanel || this.data.operationPanel || this.data.listPanel) return;
    const {id,process}=event.currentTarget.dataset;
    const order = this.data.orders.find(row => String(row.id) === String(id));
    if (!order || process!=null&&!order.processes?.some(row=>String(row.id)===String(process))) return;
    getApp().globalData.viewOrder = { ...order };
    const show = rect => {
      this.openingDetail = false;
      if (this.unloaded) return;
      this.setData({ detailOrigin: rect || null, detailOrderId: String(order.id), detailProcessId:process==null?'':String(process), detailMounted: true, detailVisible: true,
        reduceMotion: getApp().globalData.reduceMotion === true });
    };
    this.openingDetail = true;
    if (typeof wx.createSelectorQuery !== 'function') return show(null);
    wx.createSelectorQuery().select('#order-card-' + order.id).boundingClientRect().exec(rects => show(rects?.[0]));
  },
  closeDetail() { this.setData({ detailVisible: false }); },
  reopenDetail() { if (this.data.detailMounted) this.setData({ detailVisible: true }); },
  detailClosed() {
    if (this.data.detailVisible) return;
    const id = Number(this.data.detailOrderId);
    this.setData({ detailMounted: false, detailOrderId: '' });
    if (this.data.sourceMode === 'live' && Number.isSafeInteger(id) && id > 0) return this.readOrderCard(id);
  },
  onUnload() { this.unloaded = true;this.disposeOrderListTools?.();this.disposeClockout?.();this.disposeOrderOperationMotion?.();this.disposeGlassSegments?.();this.clearGlassNav?.();this.disposeProductPreview?.(); },
  async loadLive(event) {
    if (this.data.loading) {if(!event?.currentTarget?.dataset?.more)this.reloadOrdersPending=true;return;}
    const more = event?.currentTarget?.dataset?.more === true || event?.currentTarget?.dataset?.more === 'true';
    const pageNum = more ? this.data.pageNum + 1 : 1;
    this.orderListRevision = (this.orderListRevision || 0) + 1;
    if (!more) this.orderWatchOffset = 0;
    this.setData({ loading: true, loadError: '' });
    try {
      const response = await api.read(this.orderListPath(pageNum));
      if (!['blacklake-live','blacklake-snapshot'].includes(response.source) || !Array.isArray(response.orders) || response.pageNum !== pageNum) throw new Error('查询结果不符合要求，请重试。');
      const loadedOrders = [...new Map((more ? this.data.loadedOrders.concat(response.orders) : response.orders).map(order => [order.id, order])).values()];
      const timestamp = Date.parse(response.fetchedAt);
      const updated = Number.isFinite(timestamp) ? new Date(timestamp + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ') + ' 北京时间' : '更新时间未知';
      this.setData({ loadedOrders:loadedOrders.map(order=>presentCard(order,order)), pageNum, hasMore: response.hasMore, loading: false,ordersTotal:response.total,
        sourceNote: `后台工单 · 已加载${loadedOrders.length}${response.total == null ? '' : '/' + response.total}条 · ${updated}`,
        statuses: [{ key: 'ALL', label: '全部' }, ...[['NOT_STARTED', '未开始'], ['IN_PROGRESS', '执行中'], ['FINISHED', '已结束']].map(([key, label]) => ({ key, label: label + ' ' + (response.statusCounts?.[key]??loadedOrders.filter(order => order.status === key).length) }))] });
      this.applyFilters();
    } catch (error) {
      this.setData({ loading: false, loadError: error.message || '读取失败，请稍后重试。', totalLabel: this.data.loadedOrders.length ? this.data.totalLabel : '读取失败' });
    }
    if(this.reloadOrdersPending&&!this.unloaded){this.reloadOrdersPending=false;return this.loadLive();}
  },
  orderListPath(pageNum) {
    const {queryCode,listSort,activeStatus,listPriority}=this.data;
    return '/v1/orders?pageNum='+pageNum+'&projectCode='+encodeURIComponent(queryCode)+'&sort='+encodeURIComponent(listSort||'default')+'&status='+activeStatus+'&priority='+(listPriority||'ALL');
  },
  onOrderListScroll(event) { this.orderListScrollTop = event.detail.scrollTop; },
  async refreshOrderCards() {
    if (this.data.sourceMode !== 'live' || this.data.loading || !this.data.pageNum || this.orderListPolling) return;
    const interval=this.data.orders.some(row=>row.processesLoading)?10000:30000;
    if(Date.now()-(this.orderListCheckedAt||0)<interval)return;
    const revision=this.orderListRevision,path=this.orderListPath(1),offset=this.orderWatchOffset||0;
    const watch=orderListRefresh.watchedIds(this.data.loadedOrders,offset);
    this.orderListPolling=true;
    this.orderListCheckedAt=Date.now();
    try {
      const response=await api.read(path+(watch.length?'&watch='+watch.join(','):''));
      if(this.unloaded||this.hidden||this.data.workspaceTab!==0||this.data.detailMounted||revision!==this.orderListRevision||path!==this.orderListPath(1)||!Array.isArray(response.orders)||response.pageNum!==1)return;
      const loaded=this.data.loadedOrders;
      const next=orderListRefresh.mergeOrderCards(loaded,watch,response,{
        atTop:(this.orderListScrollTop||0)<=8,present:presentCard,preserve:id=>this.processLoads?.has(id)
      });
      this.orderWatchOffset=offset+watch.length>=loaded.length?0:offset+watch.length;
      const total=response.total,hasMore=this.data.pageNum*response.pageSize<total;
      const changes=next.length!==loaded.length||next.some((row,index)=>row!==loaded[index])||total!==this.data.ordersTotal;
      if(changes||hasMore!==this.data.hasMore){
        this.setData({loadedOrders:next,ordersTotal:total,hasMore,
          ...(response.statusCounts?{statuses:this.data.statuses.map(row=>row.key==='ALL'?row:{...row,label:row.label.split(' ')[0]+' '+(response.statusCounts[row.key]??0)})}:{})});
        this.applyFilters();
      }
    } catch {} finally { this.orderListPolling=false; }
  },
  loadMoreOrders(){if(this.data.sourceMode==='live'&&this.data.hasMore&&!this.data.loading&&!this.data.loadError)return this.loadLive({currentTarget:{dataset:{more:true}}});},
  patchOrderCard(id, values) {
    if(this.unloaded)return;
    const loaded=this.data.loadedOrders.findIndex(order=>order.id===id),visible=this.data.orders.findIndex(order=>order.id===id);
    if(loaded<0)return;
    const old=this.data.loadedOrders[loaded],next={...old,...values},changes={['loadedOrders['+loaded+']']:next};
    if(visible>=0)changes['orders['+visible+']']=next;
    this.setData(changes);
    if(['status','priority','code','product','productCode','productName','productSpecification','startAt'].some(key=>next[key]!==old[key]))this.applyFilters();
  },
  loadProcesses(event) { return this.readOrderCard(Number(event.currentTarget.dataset.id),true); },
  async readOrderCard(id,requested=false) {
    const current=this.data.loadedOrders.find(order=>order.id===id);
    if(this.data.sourceMode!=='live'||!current)return;
    this.processLoads ||= new Set();
    if (this.processLoads.has(id)) return;
    this.processLoads.add(id);
    if(requested)this.patchOrderCard(id,{processesRequesting:true,processesLoading:true,processesError:false});
    try {
      const response=await (requested&&current.processesError?api.refreshOrderDetail(id):api.loadOrderDetail(id));
      if(response.order?.id!==id||!Array.isArray(response.order.processes))throw new Error('工序查询失败');
      this.patchOrderCard(id,{...presentCard(response.order,current),processesRequesting:false});
    } catch(error) {
      if(requested)this.patchOrderCard(id,{processesRequesting:false,processesLoading:error.code==='BLACKLAKE_DATA_SYNCING',processesError:error.code!=='BLACKLAKE_DATA_SYNCING'});
    }
    finally { this.processLoads.delete(id); }
  },
  imageFailed(event) {
    const id = String(event.currentTarget.dataset.id),key = this.data.sourceMode === 'live' ? 'loadedOrders' : 'snapshotOrders';
    this.setData({ [key]: this.data[key].map(order => String(order.id) === id ? { ...order, imageFailed: true } : order) });
    this.applyFilters();
  },
  previewOrderImage(event) {
    const order = this.data.orders.find(row => String(row.id) === String(event.currentTarget.dataset.id));
    if (order?.imageUrl && !order.imageFailed) this.openProductPreview?.(order.imageUrl,'#order-image-'+order.id);
  },
  selectStatus(event) {
    this.setData({ activeStatus: event.currentTarget.dataset.status });
    this.applyFilters();
    if(this.data.sourceMode==='live')this.loadLive();
  },
  toggleSearch() {
    const searchOpen = !this.data.searchOpen;
    this.setData({ searchOpen, keyword: searchOpen ? this.data.keyword : "" });
    this.applyFilters();
    if(!searchOpen&&this.data.sourceMode==='live'){if(this.liveSearchTimer!=null)clearTimeout(this.liveSearchTimer);this.setData({queryCode:''});this.loadLive();}
  },
  onSearch(event) {
    this.setData({ keyword: event.detail.value });
    this.applyFilters();
  },
  applyFilters() {
    const keyword = this.data.keyword.trim().toLowerCase();
    const terms=keyword.split(/\s+/).map(searchText).filter(Boolean);
    const all = this.data.sourceMode === 'live' ? this.data.loadedOrders : this.data.snapshotOrders;
    let orders = all.filter(order =>
      (this.data.activeStatus === "ALL" || order.status === this.data.activeStatus) &&
      matchesSearch(order,terms)
    );
    if(this.filterOrderList)orders=this.filterOrderList(orders);
    this.refreshOrderListCounts?.(all);
    const narrowed=this.listCountsActivated||this.data.listScope==='mine'||this.data.listPriority&&this.data.listPriority!=='ALL';
    this.setData({ orders, totalLabel: this.data.sourceMode === 'live' ? `共 ${this.data.ordersTotal??orders.length} 张工单 · 已显示 ${orders.length}` : !narrowed && !this.data.snapshotEdited && this.data.activeStatus === "ALL" && !keyword ? "尚未读取" : `当前样本（${orders.length}）` });
  },
  ...glassNav.methods, ...photo.methods,
  // Other entries remain unavailable until their flow is supplied.
  pendingReference() {
    wx.showToast({ title: "暂未开放", icon: "none" });
  },
  scanOrder() {
    // No camera access or business lookup until the actual scan flow is supplied.
    this.pendingReference();
  }
},'orders'),'orders'));
