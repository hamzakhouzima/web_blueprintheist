const progress = document.querySelector('#reading-progress');
const sections = [...document.querySelectorAll('.chapter')];
const revealElements = [...document.querySelectorAll('.reveal')];
const links = [...document.querySelectorAll('.toc a')];

function updateProgress() {
  const available = document.documentElement.scrollHeight - window.innerHeight;
  progress.style.width = `${available > 0 ? (window.scrollY / available) * 100 : 0}%`;
}

const observer = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (entry.isIntersecting) {
      entry.target.classList.add('visible');
      if (entry.target.id) {
        const link = document.querySelector(`.toc a[href="#${entry.target.id}"]`);
        links.forEach((item) => item.classList.toggle('active', item === link));
      }
    }
  });
}, { rootMargin: '-18% 0px -68% 0px' });

revealElements.forEach((element) => observer.observe(element));
window.addEventListener('scroll', updateProgress, { passive: true });
updateProgress();

document.querySelector('#year').textContent = new Date().getFullYear();

document.querySelectorAll('.copy').forEach((button) => {
  button.addEventListener('click', async () => {
    const source = document.querySelector(`#${button.dataset.copy}`);
    try {
      await navigator.clipboard.writeText(source.innerText);
      button.textContent = 'copied';
      button.classList.add('done');
      setTimeout(() => {
        button.textContent = 'copy';
        button.classList.remove('done');
      }, 1400);
    } catch {
      button.textContent = 'select manually';
    }
  });
});