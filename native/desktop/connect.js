// SPDX-License-Identifier: MIT
const error = document.querySelector('#error');
async function connect(value) {
  error.textContent = '';
  const buttons = document.querySelectorAll('button');
  buttons.forEach((button) => {
    button.disabled = true;
  });
  try {
    await window.relayConnection.connect(value);
  } catch (e) {
    error.textContent = e.message;
  } finally {
    buttons.forEach((button) => {
      button.disabled = false;
    });
  }
}
document.querySelector('#connect').addEventListener('submit', (event) => {
  event.preventDefault();
  void connect(document.querySelector('#server').value);
});
document.querySelector('#local').addEventListener('click', () => void connect(''));
