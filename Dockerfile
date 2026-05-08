FROM node:20-slim AS builder

RUN apt-get update && apt-get install -y python3 python3-pip make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json .
RUN npm install

COPY tsconfig.json .
COPY src/ ./src/
RUN npm run build


FROM node:20-slim AS production

RUN apt-get update && apt-get install -y python3 python3-pip make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json .
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
