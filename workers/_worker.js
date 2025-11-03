// workers/api.js
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    // 设置CORS头
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
    
    // 处理预检请求
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: corsHeaders,
      });
    }
    
    // API路由
    if (path.startsWith('/api/')) {
      // 认证中间件
      const authResult = await authenticate(request, env);
      if (!authResult.authenticated && !path.includes('/login')) {
        return jsonResponse({ error: '未授权访问' }, 401, corsHeaders);
      }
      
      const user = authResult.user;
      
      // 路由处理
      if (path === '/api/login' && request.method === 'POST') {
        return handleLogin(request, env);
      } else if (path === '/api/user' && request.method === 'GET') {
        return handleGetUser(user, env);
      } else if (path === '/api/files' && request.method === 'GET') {
        return handleGetFiles(user, env);
      } else if (path === '/api/upload' && request.method === 'POST') {
        return handleUpload(request, user, env);
      } else if (path.startsWith('/api/download/') && request.method === 'GET') {
        const fileId = path.split('/').pop();
        return handleDownload(fileId, user, env);
      } else if (path.startsWith('/api/share/') && request.method === 'POST') {
        const fileId = path.split('/').pop();
        return handleShare(fileId, user, env);
      } else if (path.startsWith('/api/files/') && request.method === 'DELETE') {
        const fileId = path.split('/').pop();
        return handleDelete(fileId, user, env);
      } else {
        return jsonResponse({ error: '接口不存在' }, 404, corsHeaders);
      }
    }
    
    // 默认响应
    return jsonResponse({ message: 'HTTP文档网盘API' }, 200, corsHeaders);
  },
};

// 认证函数
async function authenticate(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { authenticated: false };
  }
  
  const token = authHeader.substring(7);
  try {
    const userData = await env.KV_STORE.get(`token:${token}`);
    if (!userData) {
      return { authenticated: false };
    }
    
    const user = JSON.parse(userData);
    return { authenticated: true, user };
  } catch (error) {
    return { authenticated: false };
  }
}

// 处理登录
async function handleLogin(request, env) {
  try {
    const { username, password } = await request.json();
    
    // 简单的用户验证（生产环境应使用更安全的方式）
    const userKey = `user:${username}`;
    const userData = await env.KV_STORE.get(userKey);
    
    if (!userData) {
      // 首次使用，创建用户
      const newUser = {
        id: generateId(),
        username,
        createdAt: new Date().toISOString(),
      };
      
      await env.KV_STORE.put(userKey, JSON.stringify(newUser));
    } else {
      // 验证用户（这里简化了，实际应验证密码）
      const user = JSON.parse(userData);
    }
    
    // 生成token
    const token = generateToken();
    await env.KV_STORE.put(`token:${token}`, JSON.stringify({ username }), {
      expirationTtl: 86400, // 24小时
    });
    
    return jsonResponse({ token, username }, 200, corsHeaders);
  } catch (error) {
    return jsonResponse({ error: '登录失败' }, 400, corsHeaders);
  }
}

// 获取用户信息
async function handleGetUser(user, env) {
  return jsonResponse({ username: user.username }, 200, corsHeaders);
}

// 获取文件列表
async function handleGetFiles(user, env) {
  try {
    const userFilesKey = `files:${user.username}`;
    const filesData = await env.KV_STORE.get(userFilesKey);
    const files = filesData ? JSON.parse(filesData) : [];
    
    return jsonResponse(files, 200, corsHeaders);
  } catch (error) {
    return jsonResponse({ error: '获取文件列表失败' }, 500, corsHeaders);
  }
}

// 处理文件上传
async function handleUpload(request, user, env) {
  try {
    const formData = await request.formData();
    const file = formData.get('file');
    
    if (!file) {
      return jsonResponse({ error: '未选择文件' }, 400, corsHeaders);
    }
    
    // 生成文件ID
    const fileId = generateId();
    const fileName = file.name;
    const fileSize = file.size;
    
    // 存储文件到R2
    await env.R2_BUCKET.put(fileId, file);
    
    // 更新文件列表
    const userFilesKey = `files:${user.username}`;
    const filesData = await env.KV_STORE.get(userFilesKey);
    const files = filesData ? JSON.parse(filesData) : [];
    
    const newFile = {
      id: fileId,
      name: fileName,
      size: fileSize,
      uploadedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    
    files.push(newFile);
    await env.KV_STORE.put(userFilesKey, JSON.stringify(files));
    
    return jsonResponse({ message: '上传成功', file: newFile }, 200, corsHeaders);
  } catch (error) {
    return jsonResponse({ error: '上传失败' }, 500, corsHeaders);
  }
}

// 处理文件下载
async function handleDownload(fileId, user, env) {
  try {
    // 验证用户是否有权限下载此文件
    const userFilesKey = `files:${user.username}`;
    const filesData = await env.KV_STORE.get(userFilesKey);
    const files = filesData ? JSON.parse(filesData) : [];
    
    const file = files.find(f => f.id === fileId);
    if (!file) {
      return jsonResponse({ error: '文件不存在' }, 404, corsHeaders);
    }
    
    // 从R2获取文件
    const object = await env.R2_BUCKET.get(fileId);
    if (!object) {
      return jsonResponse({ error: '文件不存在' }, 404, corsHeaders);
    }
    
    const headers = new Headers();
    headers.set('Content-Type', 'application/octet-stream');
    headers.set('Content-Disposition', `attachment; filename="${file.name}"`);
    headers.set('Access-Control-Allow-Origin', '*');
    
    return new Response(object.body, {
      headers,
    });
  } catch (error) {
    return jsonResponse({ error: '下载失败' }, 500, corsHeaders);
  }
}

// 处理文件分享
async function handleShare(fileId, user, env) {
  try {
    // 验证用户是否有权限分享此文件
    const userFilesKey = `files:${user.username}`;
    const filesData = await env.KV_STORE.get(userFilesKey);
    const files = filesData ? JSON.parse(filesData) : [];
    
    const file = files.find(f => f.id === fileId);
    if (!file) {
      return jsonResponse({ error: '文件不存在' }, 404, corsHeaders);
    }
    
    // 生成分享令牌
    const shareToken = generateToken();
    const shareData = {
      fileId,
      fileName: file.name,
      sharedBy: user.username,
      sharedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), // 7天后过期
    };
    
    await env.KV_STORE.put(`share:${shareToken}`, JSON.stringify(shareData), {
      expirationTtl: 7 * 24 * 60 * 60, // 7天
    });
    
    // 生成分享链接
    const shareUrl = `${request.url.replace('/api/share/', '/share/')}${shareToken}`;
    
    return jsonResponse({ shareUrl }, 200, corsHeaders);
  } catch (error) {
    return jsonResponse({ error: '分享失败' }, 500, corsHeaders);
  }
}

// 处理文件删除
async function handleDelete(fileId, user, env) {
  try {
    // 验证用户是否有权限删除此文件
    const userFilesKey = `files:${user.username}`;
    const filesData = await env.KV_STORE.get(userFilesKey);
    const files = filesData ? JSON.parse(filesData) : [];
    
    const fileIndex = files.findIndex(f => f.id === fileId);
    if (fileIndex === -1) {
      return jsonResponse({ error: '文件不存在' }, 404, corsHeaders);
    }
    
    // 从R2删除文件
    await env.R2_BUCKET.delete(fileId);
    
    // 从文件列表中删除
    files.splice(fileIndex, 1);
    await env.KV_STORE.put(userFilesKey, JSON.stringify(files));
    
    return jsonResponse({ message: '删除成功' }, 200, corsHeaders);
  } catch (error) {
    return jsonResponse({ error: '删除失败' }, 500, corsHeaders);
  }
}

// 工具函数：生成随机ID
function generateId() {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

// 工具函数：生成随机令牌
function generateToken() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}

// 工具函数：返回JSON响应
function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });
}

// CORS头
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
