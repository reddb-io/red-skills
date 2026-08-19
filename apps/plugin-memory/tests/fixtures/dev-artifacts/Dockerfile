FROM node:22-alpine AS base
COPY package.json package.json
RUN npm ci
CMD ["node", "dist/server.js"]
