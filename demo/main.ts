import { Clip, mp3Adapter } from '../src/index';

const clip = new Clip({
  url: '/demo/deepnote.mp3',
  adapter: mp3Adapter,
});

clip.buffer().then(() => {
  const play = document.querySelector('#play') as HTMLButtonElement;
  const pause = document.querySelector('#pause') as HTMLButtonElement;

  play.disabled = false;
  pause.disabled = false;

  play.addEventListener('click', () => {
    clip.play();
  });

  pause.addEventListener('click', () => {
    clip.pause();
  });
});