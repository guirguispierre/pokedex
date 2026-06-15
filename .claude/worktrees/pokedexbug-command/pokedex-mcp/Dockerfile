FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build
ENV MCP_TRANSPORT=http
ENV PORT=3001
EXPOSE 3001
CMD ["node", "dist/index.js"]
