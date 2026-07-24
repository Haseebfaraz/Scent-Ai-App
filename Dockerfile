FROM node:20-alpine

RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./

# Install ALL dependencies (including devDependencies required for npm run build)
RUN npm ci && npm cache clean --force

COPY . .

# Run build step while devDependencies are present
RUN npm run build

# Clean up dev dependencies after build to keep image light
RUN npm prune --omit=dev

CMD ["npm", "run", "docker-start"]