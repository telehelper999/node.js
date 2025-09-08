#!/bin/bash
# VPS Deployment Script for Socket.IO + Python Backend

echo "🚀 Starting VPS Deployment Setup"
echo "=================================="

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo "❌ Please run as root or with sudo"
    exit 1
fi

# Update system
echo "📦 Updating system packages..."
apt update && apt upgrade -y

# Install Node.js 20
echo "📦 Installing Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# Install PM2 globally
echo "📦 Installing PM2 process manager..."
npm install -g pm2

# Install Redis Server
echo "📦 Installing Redis Server..."
apt install -y redis-server

# Configure Redis with password
echo "🔐 Configuring Redis security..."
REDIS_PASSWORD=${REDIS_PASSWORD:-$(openssl rand -base64 32)}
echo "requirepass $REDIS_PASSWORD" >> /etc/redis/redis.conf
echo "bind 127.0.0.1" >> /etc/redis/redis.conf
systemctl restart redis-server
systemctl enable redis-server

# Install Nginx
echo "📦 Installing Nginx..."
apt install -y nginx

# Install Certbot for SSL
echo "📦 Installing Certbot for SSL..."
apt install -y certbot python3-certbot-nginx

# Create application directory
echo "📁 Setting up application directories..."
mkdir -p /var/www/socketio
mkdir -p /var/log/socketio

# Set permissions
chown -R www-data:www-data /var/www/socketio
chmod -R 755 /var/www/socketio

# Copy files (assuming you've uploaded them)
echo "📋 Copy your application files to /var/www/socketio/"
echo "   - server.js"
echo "   - package.json"  
echo "   - ecosystem.config.js"
echo "   - nginx.conf (for reference)"

# Install dependencies
echo "📦 Installing Node.js dependencies..."
cd /var/www/socketio
npm install

# Configure environment
echo "⚙️ Setting up environment variables..."
cat > .env << EOF
SOCKETIO_PORT=3001
HOST=127.0.0.1
SERVER_ID=vps-main
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=$REDIS_PASSWORD
ALLOWED_ORIGINS=https://yourdomain.com
NODE_ENV=production
EOF

# Start with PM2
echo "🚀 Starting Socket.IO server with PM2..."
pm2 start ecosystem.config.js
pm2 save
pm2 startup

# Configure Nginx (manual step)
echo "🔧 MANUAL STEPS REQUIRED:"
echo "=================================="
echo "1. Edit /etc/nginx/sites-available/your-domain.com"
echo "   Copy the nginx.conf configuration and update domain name"
echo ""
echo "2. Enable the site:"
echo "   ln -s /etc/nginx/sites-available/your-domain.com /etc/nginx/sites-enabled/"
echo ""
echo "3. Test Nginx configuration:"
echo "   nginx -t"
echo ""
echo "4. Get SSL certificate:"
echo "   certbot --nginx -d yourdomain.com -d www.yourdomain.com"
echo ""
echo "5. Restart Nginx:"
echo "   systemctl restart nginx"
echo ""
echo "✅ VPS setup complete!"
echo "📊 Monitor with: pm2 monit"
echo "📋 View logs: pm2 logs"
echo "🔐 Redis password: $REDIS_PASSWORD"
echo ""
echo "🌐 Your Socket.IO server will be available at:"
echo "   wss://yourdomain.com/socket.io/"