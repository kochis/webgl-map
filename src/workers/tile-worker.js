import { fetchTile } from '../utils/map-utils';

addEventListener('message', async (event) => {
  const { tile, layers, url } = event.data;

  try {
    const tileData = await fetchTile({ tile, layers, url });
    postMessage({ tile, tileData });

  } catch (e) {
    console.warn('Worker error.', e);
    postMessage({ tile }); // undefined tileData will unset cache hold
  }
});
