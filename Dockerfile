FROM node:24-alpine

WORKDIR /app

# Install dependencies first (layer-cached when only source changes)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source — .dockerignore excludes node_modules, data/, tests/, .git/
COPY . .

EXPOSE 3000

ENV NODE_ENV=production

CMD ["node", "src/app.js"]
