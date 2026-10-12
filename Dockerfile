# The DEX Scout background workers (scanner, analysis, signals, position monitor, bot) as one always-on process.
# This is NOT the website: that stays on Vercel (or anywhere that runs `next start`). See WORKER.md.
FROM node:22-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .

ENV NODE_ENV=production
# every secret comes from the environment (docker-compose.yml passes .env.worker); nothing is baked into the image
CMD ["npm", "run", "workers"]
