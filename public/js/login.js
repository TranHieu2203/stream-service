function showError(message) {
    const errorDiv = document.getElementById('error-message');
    errorDiv.textContent = message;
    errorDiv.style.display = 'block';
}

function hideError() {
    const errorDiv = document.getElementById('error-message');
    errorDiv.style.display = 'none';
}

function loginAAD() {
    hideError(); // Hide any existing error message
    console.log('Login button clicked, making request to /stream/request-login-token');
    fetch('/stream/request-login-token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        }
    })
    .then(response => response.json())
    .then(data => {
        if (data.success && data.login_url) {
            console.log('Redirecting to login URL:', data.login_url);
            // Open Microsoft login in a new window
            window.open(data.login_url, '_self');
        } else {
            console.error('Login failed:', data.message);
            showError('Có lỗi xảy ra khi đăng nhập. Vui lòng thử lại.');
        }
    })
    .catch(error => {
        console.error('Login error:', error);
        console.error('Error details:', {
            message: error.message,
            stack: error.stack
        });
        showError('Có lỗi xảy ra khi đăng nhập. Vui lòng thử lại.');
    });
}
