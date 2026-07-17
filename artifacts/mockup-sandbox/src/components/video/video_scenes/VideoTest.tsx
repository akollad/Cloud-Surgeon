import { useEffect } from 'react';
export function VideoTest() {
  useEffect(() => {
    console.log('BASE_URL is:', import.meta.env.BASE_URL);
  }, []);
  return null;
}
