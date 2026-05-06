const express = require('express');
const axios = require('axios');
const router = express.Router();
const RedisC = require("../service/Redis");
const Redis = new RedisC();

router.get('/login', (req, res) => {
  res.render('login.ejs');
});

router.post('/stream/request-login-token', async (req, res) => {
  try {
    console.log('Requesting login token from AAD API...');
    console.log('AAD API Base URL:', process.env.AAD_API_BASE);
    
    const response = await axios.post(
      `${process.env.AAD_API_BASE}/api/authentication/request-login-token`,
      {
        service: 'aad',
        "": {}
      },
      {
        headers: {
          'x-api-key': process.env.SESSION_SECRET,
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.9,vi;q=0.8',
          'Connection': 'keep-alive'
        }
      }
    );
    
    console.log('AAD API Response Status Code:', response.status);
    console.log('AAD API Response:', response.data);
    
    if (response.status === 201 && response.data.success) {
      // Store the token in session
      const token = response.data.data._token;
      console.log('Extracted token:', token);
      req.session.loginToken = token;
      console.log('Token stored in session:', req.session.loginToken);
      
      // Return the login URL to the client
      const loginUrl = response.data.data.login_url;
      console.log('Returning login URL:', loginUrl);
      
      res.json({
        success: true,
        login_url: loginUrl
      });
    } else {
      console.error('Invalid response from AAD API:', response.data);
      res.status(500).json({ 
        success: false, 
        message: 'Lỗi lấy token' 
      });
    }
  } catch (e) {
    console.error('Error getting login token:', e);
    console.error('Error details:', {
      message: e.message,
      response: e.response?.data,
      status: e.response?.status,
      statusCode: e.response?.statusCode,
      headers: e.response?.headers
    });
    res.status(500).json({ 
      success: false, 
      message: 'Lỗi lấy token' 
    });
  }
});

router.post('/auth-verify', async (req, res) => {
  try {
    console.log('Received auth verify request:', req.body);
    
    // Extract user data from request
    const { service, user_data } = req.body;
    
    // Log the incoming request details
    console.log('Auth verify request details:', {
      service,
      email: user_data?.email,
      full_name: user_data?.full_name,
      localAccountId: user_data?.additional?.localAccountId || user_data?.ext?.localAccountId
    });

    // Store email in Redis with 5 minutes expiry
    const userOpenId = user_data?.additional?.localAccountId || user_data?.ext?.localAccountId;
    if (user_data?.email && userOpenId) {
      await Redis.getClient().set(`USER_EMAIL_${userOpenId}`, user_data.email, 'EX', 300);
      console.log('Stored email in Redis:', user_data.email);
    }

    // Create response matching C# class structure
    const response = {
      success: true,
      data: {
        USER_OPENID: userOpenId,
        SERVICE_ACCESS_TOKEN: 'SERVICE_ACCESS_TOKEN_VALUE'
      }
    };

    console.log('Auth verify response:', response);

    // Store the USER_OPENID in session
    req.session.user_openid = response.data.USER_OPENID;
    req.session.service_access_token = response.data.SERVICE_ACCESS_TOKEN;

    console.log('Session updated with verify tokens:', {
      user_openid: !!response.data.USER_OPENID,
      service_access_token: !!response.data.SERVICE_ACCESS_TOKEN,
      user_email: user_data?.email
    });

    // Return the response
    res.json(response);

  } catch (e) {
    console.error('Error during auth verify:', e);
    console.error('Error details:', {
      message: e.message,
      response: e.response?.data,
      status: e.response?.status,
      statusCode: e.response?.statusCode,
      headers: e.response?.headers
    });
    res.status(500).json({ 
      success: false, 
      message: 'Lỗi xác thực' 
    });
  }
});

router.post('/auth-redirect', async (req, res) => {
  console.log('Full Microsoft Request:', req.body);
  console.log('Received Microsoft redirect with data:', {
    login_success: req.body.login_success,
    login_message: req.body.login_message,
    id_token: req.body.id_token,
    user_id: req.body.user_id,
    additional: req.body.additional,
    user_access_token: req.body.user_access_token,
    user_refresh_token: req.body.user_refresh_token,
    service_access_token: req.body.service_access_token
  });

  // Get user email from Redis using user_id
  const userEmail = await Redis.getClient().get(`USER_EMAIL_${req.body.user_id}`);
  console.log('Retrieved email from Redis:', userEmail);
  
  // Get allowed emails from environment variable
  const allowedEmails = process.env.ALLOWED_EMAILS ? process.env.ALLOWED_EMAILS.split(',') : [];
  
  // Check if user's email is in allowed list
  const isAllowedUser = allowedEmails.includes(userEmail);

  console.log('Auth redirect authorization check:', {
    email: userEmail,
    isAllowedUser
  });

  if (!isAllowedUser) {
    console.log('Access denied for user:', userEmail);
    // Clear any existing session data
    req.session.destroy((err) => {
      if (err) {
        console.error('Error destroying session:', err);
      }
      // Set headers to prevent caching and back navigation
      res.set({
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
        'Surrogate-Control': 'no-store'
      });
      // Redirect to login with error message
      // res.redirect('/login?error=unauthorized');
      res.render('login.ejs', { 
        errorMessage: 'Bạn không có quyền truy cập vào hệ thống. Vui lòng liên hệ Admin Ban CNTT để được phân quyền.'
      });
    });
    return;
  }

  // If user is authorized, store session data
  req.session.id_token = req.body.id_token;
  req.session.user_id = req.body.user_id;
  req.session.access_token = req.body.user_access_token;
  req.session.refresh_token = req.body.user_refresh_token;
  req.session.service_access_token = req.body.service_access_token;
  req.session.user_email = userEmail; // Store email in session for future use

  console.log('Session updated with tokens POST:', {
    id_token: !!req.body.id_token,
    user_id: !!req.body.user_id,
    access_token: !!req.body.user_access_token,
    refresh_token: !!req.body.user_refresh_token,
    service_access_token: !!req.body.service_access_token,
    user_email: userEmail
  });

  // Set headers to prevent caching and back navigation
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
    'Surrogate-Control': 'no-store'
  });

  // Redirect to index page
  res.redirect('/');
});

router.post('/logout', (req, res) => {
  // Clear all session data
  req.session.destroy((err) => {
    if (err) {
      console.error('Error destroying session:', err);
      return res.redirect('/login');
    }

    // Clear any cookies
    res.clearCookie('connect.sid');
    
    // Log the logout
    console.log('User logged out successfully');
    
    // Set headers to prevent caching and back navigation
    res.set({
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      'Surrogate-Control': 'no-store'
    });
    
    // Redirect to login page
    res.redirect('/login');
  });
});

module.exports = router;
