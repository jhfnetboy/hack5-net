FROM node:22-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY vps ./vps

WORKDIR /app/vps
ENV NODE_ENV=production
ENV PORT=8787
EXPOSE 8787

CMD ["node", "server.mjs"]
