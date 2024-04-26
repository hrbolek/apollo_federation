###############################################################
#
# First phase
#
###############################################################
FROM node:14 as buildnode

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
# A wildcard is used to ensure both package.json AND package-lock.json are copied
# where available (npm@5+)
COPY package*.json ./

# Build for development
RUN npm install
###############################
# =====PRODUCTION BUILD=======
# RUN npm ci --only=production
# ENV NODE_ENV=production
###############################

# Bundle app source
COPY . .

CMD ["node", "server"]
