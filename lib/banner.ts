import chalk from 'chalk';
import figlet from 'figlet';

export function renderBanner(): string {
  const art = figlet.textSync('ORC-STATE', { font: 'Doom' });
  return chalk.green(chalk.bold(art));
}
