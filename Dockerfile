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

RUN npm install
# If you are building your code for production
# RUN npm ci --only=production

RUN npm install pm2 -g

# Bundle app source
COPY . .

# RUN useradd appuser && chown -R appuser /usr/src/app
# USER appuser

# CMD ["node", "server"]
CMD ["pm2-runtime", "server.js"]
