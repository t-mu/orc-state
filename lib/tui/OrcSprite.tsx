import { Text } from 'ink';
import { useEffect, useState } from 'react';
import type { SpriteMap, SpriteState } from './sprites.ts';

export function OrcSprite({ spriteState, sprites }: { spriteState: SpriteState; sprites: SpriteMap }) {
  const frames = sprites.get(spriteState) ?? sprites.get('idle') ?? ['?'];
  const [index, setIndex] = useState(0);

  useEffect(() => {
    setIndex(0);
    if (frames.length <= 1) {
      return undefined;
    }

    const timer = setInterval(() => {
      setIndex(current => (current + 1) % frames.length);
    }, 500);

    return () => clearInterval(timer);
  }, [frames]);

  return <Text>{frames[index] ?? frames[0] ?? '?'}</Text>;
}
