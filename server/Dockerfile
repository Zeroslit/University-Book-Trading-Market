# 后端镜像：Node 20（与 package.json engines 一致）
FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production TZ=Asia/Shanghai

# 先装依赖以利用镜像层缓存
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY src ./src
RUN mkdir -p uploads

EXPOSE 3000
CMD ["node", "src/server.js"]
