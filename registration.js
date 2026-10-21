class RegistrationSystem {
    constructor() {
        const rn = document.getElementById('rightNav');
        if (rn) rn.style.display = 'none';
        this.wrapper = document.getElementById('registerWrapper');
        this.form = document.getElementById('registerForm');
        this.avatarPreview = document.getElementById('avatarPreview');
        this.nameInput = document.getElementById('regName');
        this.usernameInput = document.getElementById('regUsername');
        this.init();
    }
    init() {
        const user = this.getUser();
        if (user) { this.hideRegisterPage(); this.applyProfileToUI(user); return; }
        this.nameInput.addEventListener('input', () => this.updateAvatar());
        this.usernameInput.addEventListener('input', (e) => {
            e.target.value = e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20);
        });
        this.form.addEventListener('submit', (e) => { e.preventDefault(); this.handleSubmit(); });
        document.getElementById('skipToApp').addEventListener('click', (e) => {
            e.preventDefault();
            const guestUser = { name: 'Гость', username: 'guest', email: '', avatar: '👤', registeredAt: new Date().toISOString(), isGuest: true };
            localStorage.setItem('user', JSON.stringify(guestUser));
            this.hideRegisterPage(); this.applyProfileToUI(guestUser);
        });
    }
    updateAvatar() {
        const name = this.nameInput.value.trim();
        this.avatarPreview.textContent = name.length > 0 ? name.charAt(0).toUpperCase() : '?';
    }
    validate() {
        let isValid = true;
        document.querySelectorAll('.form-input').forEach(i => i.classList.remove('error'));
        document.querySelectorAll('.form-error').forEach(e => e.textContent = '');
        const name = this.nameInput.value.trim();
        const username = this.usernameInput.value.trim();
        const email = document.getElementById('regEmail').value.trim();
        const password = document.getElementById('regPassword').value;
        const passwordConfirm = document.getElementById('regPasswordConfirm').value;

        if (name.length < 2) { this.showError('regName', 'errName', 'Минимум 2 символа'); isValid = false; }
        if (username.length < 3) { this.showError('regUsername', 'errUsername', 'Минимум 3 символа'); isValid = false; }
        else if (!/^[a-z0-9_]+$/.test(username)) { this.showError('regUsername', 'errUsername', 'Только латиница, цифры и _'); isValid = false; }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { this.showError('regEmail', 'errEmail', 'Некорректный email'); isValid = false; }
        if (password.length < 6) { this.showError('regPassword', 'errPassword', 'Минимум 6 символов'); isValid = false; }
        if (password !== passwordConfirm) { this.showError('regPasswordConfirm', 'errPasswordConfirm', 'Пароли не совпадают'); isValid = false; }
        return isValid;
    }
    showError(inputId, errorId, message) {
        document.getElementById(inputId).classList.add('error');
        document.getElementById(errorId).textContent = message;
    }
    handleSubmit() {
        if (!this.validate()) return;
        const btn = document.getElementById('registerSubmit');
        btn.disabled = true; btn.textContent = 'Создание...';
        const user = {
            name: this.nameInput.value.trim(), username: this.usernameInput.value.trim(),
            email: document.getElementById('regEmail').value.trim(),
            avatar: this.avatarPreview.textContent, registeredAt: new Date().toISOString(), isGuest: false
        };
        setTimeout(() => {
            localStorage.setItem('user', JSON.stringify(user));
            this.applyProfileToUI(user); this.hideRegisterPage();
            const n = document.createElement('div');
            n.textContent = `🎉 Добро пожаловать, ${user.name}!`;
            n.style.cssText = `position: fixed; top: 100px; right: 20px; padding: 18px 28px; background: rgba(76, 175, 80, 0.95); border-radius: 14px; color: white; font-weight: 600; z-index: 10000; animation: slideIn 0.4s ease forwards;`;
            document.body.appendChild(n);
            setTimeout(() => n.remove(), 3500);
        }, 800);
    }
    applyProfileToUI(user) {
        document.querySelectorAll('.profile-avatar, .profile-avatar-large').forEach(el => el.textContent = user.avatar);
        const profileName = document.querySelector('.profile-name');
        const profileUsername = document.querySelector('.profile-username');
        if (profileName) profileName.textContent = user.name;
        if (profileUsername) {
            const date = new Date(user.registeredAt);
            const months = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
            profileUsername.textContent = `@${user.username} · На платформе с ${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`;
        }
    }
    hideRegisterPage() {
        this.wrapper.classList.add('hidden');
        setTimeout(() => { this.wrapper.style.display = 'none'; }, 600);
        const rn = document.getElementById('rightNav');
        if (rn) rn.style.display = 'flex';
    }
    getUser() { try { return JSON.parse(localStorage.getItem('user')); } catch { return null; } }
    static logout() {
        if (confirm('Выйти из аккаунта? Все данные будут удалены.')) {
            localStorage.removeItem('user'); location.reload();
        }
    }
}