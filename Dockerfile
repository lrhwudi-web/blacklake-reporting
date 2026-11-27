FROM node:24-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4180 \
    DATABASE_PATH=/data/reporting.sqlite

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY apps/api ./apps/api
COPY apps/admin ./apps/admin
COPY data/analysis/process-inference-rules.json ./data/analysis/process-inference-rules.json
COPY data/analysis/dispatch-prediction-rules.json ./data/analysis/dispatch-prediction-rules.json
COPY data/analysis/defect-reasons.json ./data/analysis/defect-reasons.json

RUN mkdir -p /data && chown -R node:node /app /data
USER node

EXPOSE 4180
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4180/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "apps/api/src/server.mjs"]
