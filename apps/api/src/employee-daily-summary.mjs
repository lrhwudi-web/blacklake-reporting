import {effectiveWorkSecondsBetween,workingIntervalsBetween} from './work-time.mjs';

const DAY=86400000,OFFSET=8*3600000;
const stamp=ms=>new Date(ms+OFFSET).toISOString().slice(0,19).replace('T',' ');
const milliseconds=value=>{
  const text=String(value||'').trim().replace(' ','T');
  return Date.parse(text+(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)?'':'+08:00'));
};

// Personal, complete within local saved assignments; independent of recent-page
// limits. Hours cover today's completed-task intervals, merged before excluding
// lunch so multiple embroidery machines do not multiply one person's hours.
export function employeeDailySummary(store,blacklakeOperatorId,{now=Date.now}={}) {
  const at=Number(now()),start=Math.floor((at+OFFSET)/DAY)*DAY-OFFSET,end=start+DAY;
  const from=stamp(start),to=stamp(end);
  const rows=store.db.prepare(`SELECT a.status,a.started_at,a.ended_at,a.quantity_policy,a.id,d.data_json
    FROM assignments a LEFT JOIN reports r ON r.id=a.report_id LEFT JOIN report_production_details d ON d.report_id=r.id
    JOIN operators o ON o.id=CASE WHEN a.status='COMPLETED' THEN COALESCE(r.operator_id,a.operator_id) ELSE a.operator_id END
    WHERE o.blacklake_operator_id=? AND COALESCE(json_extract(d.data_json,'$.endedAt'),a.ended_at)>=? AND COALESCE(json_extract(d.data_json,'$.endedAt'),a.ended_at)<?
      AND a.status IN ('COMPLETED','QUANTITY_PENDING','REPORTING','NEEDS_REVIEW')`).all(blacklakeOperatorId,from,to);
  const completed=rows.filter(row=>row.status==='COMPLETED');
  const undatedCount=store.db.prepare(`SELECT COUNT(*) AS n FROM assignments a LEFT JOIN reports r ON r.id=a.report_id LEFT JOIN report_production_details d ON d.report_id=r.id JOIN operators o ON o.id=COALESCE(r.operator_id,a.operator_id)
    WHERE o.blacklake_operator_id=? AND a.status='COMPLETED' AND (COALESCE(json_extract(d.data_json,'$.endedAt'),a.ended_at) IS NULL OR julianday(COALESCE(json_extract(d.data_json,'$.endedAt'),a.ended_at)) IS NULL)`).get(blacklakeOperatorId).n;
  const intervals=[];let unknownDurationCount=0,manualSeconds=0,manualOverlapCount=0;
  for(const row of completed){
    const correction=row.data_json?JSON.parse(row.data_json):null;
    const begun=milliseconds(correction?.startedAt??row.started_at),ended=milliseconds(correction?.endedAt??row.ended_at);
    if(!Number.isFinite(begun)||!Number.isFinite(ended)||ended<begun||ended>at){unknownDurationCount++;continue;}
    const pauses=store.assignmentPauses(row.id),available=effectiveWorkSecondsBetween(begun,ended,pauses);
    if(correction&&correction.durationSeconds!==available){
      const overlap=correction.durationSeconds>0&&completed.some(other=>{if(other.id===row.id)return false;const detail=other.data_json?JSON.parse(other.data_json):null,a=milliseconds(detail?.startedAt??other.started_at),b=milliseconds(detail?.endedAt??other.ended_at);return a<ended&&b>begun&&effectiveWorkSecondsBetween(Math.max(a,begun),Math.min(b,ended))>0;});
      if(begun<start||ended>end||overlap){unknownDurationCount++;if(overlap)manualOverlapCount++;continue;}
      manualSeconds+=correction.durationSeconds;continue;
    }
    intervals.push(...workingIntervalsBetween(Math.max(start,begun),Math.min(end,ended),pauses));
  }
  intervals.sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
  // A manual duration does not locate its productive minutes within the span.
  // Do not invent an overlap/cross-day allocation when it cannot be determined.
  const merged=[];
  for(const interval of intervals){const last=merged.at(-1);if(last&&interval[0]<=last[1])last[1]=Math.max(last[1],interval[1]);else merged.push([...interval]);}
  const workSeconds=unknownDurationCount||undatedCount?null:manualSeconds+merged.reduce((total,[a,b])=>total+effectiveWorkSecondsBetween(a,b),0);
  return {date:from.slice(0,10),timezone:'Asia/Shanghai',from,to,asOf:stamp(at),source:'local_assignments',
    scopeDescription:'本人在本系统今日已完成的任务，按实际结束日期统计；不含其他入口未导入的黑湖历史。',
    completedCount:completed.length,workSeconds,unknownDurationCount,undatedCount,completeWithinScope:undatedCount===0&&unknownDurationCount===0,
    quantityPendingCount:rows.filter(row=>row.status==='QUANTITY_PENDING').length,
    resultPendingCount:rows.filter(row=>['REPORTING','NEEDS_REVIEW'].includes(row.status)).length,
    manualOverlapCount,workTimePolicy:manualSeconds||manualOverlapCount?'CORRECTED_EFFECTIVE_HOURS_WITH_UNKNOWN_OVERLAP':'TODAY_COMPLETED_INTERVAL_UNION_EXCLUDING_LUNCH_AND_PAUSES'};
}
