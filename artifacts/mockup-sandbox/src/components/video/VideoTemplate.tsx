import { useVideoPlayer } from '@/lib/video';
import { AnimatePresence, motion } from 'framer-motion';

import { Scene0Hook } from './video_scenes/Scene0Hook';
import { Scene1Diagnose } from './video_scenes/Scene1Diagnose';
import { Scene2Repair } from './video_scenes/Scene2Repair';
import { Scene3Memory } from './video_scenes/Scene3Memory';
import { Scene4Chaos } from './video_scenes/Scene4Chaos';
import { Scene5Learn } from './video_scenes/Scene5Learn';
import { Scene6Outro } from './video_scenes/Scene6Outro';

const SCENE_DURATIONS = {
  0: 6000,
  1: 8000,
  2: 7000,
  3: 7000,
  4: 8000,
  5: 7000,
  6: 8000,
};

export default function VideoTemplate() {
  const { currentScene } = useVideoPlayer({
    durations: SCENE_DURATIONS,
  });

  return (
    <div
      className="w-full h-screen overflow-hidden relative font-sans text-foreground"
      style={{ backgroundColor: 'hsl(var(--background))' }}
    >
      {/* Animated Background — radial gradient constellation */}
      <div className="absolute inset-0 overflow-hidden">
        <div
          className="absolute inset-0"
          style={{
            background:
              'radial-gradient(ellipse 80% 60% at 20% 40%, rgba(0,212,255,0.08) 0%, transparent 60%), radial-gradient(ellipse 60% 80% at 80% 60%, rgba(245,158,11,0.06) 0%, transparent 60%)',
          }}
        />
        {/* Drifting orbs */}
        <motion.div
          className="absolute w-[40vw] h-[40vw] rounded-full"
          style={{
            background: 'radial-gradient(circle, rgba(0,212,255,0.12) 0%, transparent 70%)',
            top: '-10%', left: '-10%',
          }}
          animate={{ x: ['0%', '15%', '0%'], y: ['0%', '10%', '0%'] }}
          transition={{ duration: 20, repeat: Infinity, ease: 'easeInOut' }}
        />
        <motion.div
          className="absolute w-[30vw] h-[30vw] rounded-full"
          style={{
            background: 'radial-gradient(circle, rgba(245,158,11,0.08) 0%, transparent 70%)',
            bottom: '-10%', right: '-5%',
          }}
          animate={{ x: ['0%', '-12%', '0%'], y: ['0%', '-8%', '0%'] }}
          transition={{ duration: 25, repeat: Infinity, ease: 'easeInOut' }}
        />
      </div>

      {/* Grid Pattern */}
      <div 
        className="absolute inset-0 opacity-10"
        style={{
          backgroundImage: 'linear-gradient(rgba(255, 255, 255, 0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255, 255, 255, 0.1) 1px, transparent 1px)',
          backgroundSize: '4vw 4vw',
          backgroundPosition: 'center center'
        }}
      />
      
      {/* Vignette */}
      <div className="absolute inset-0 bg-gradient-to-t from-background via-transparent to-background opacity-80" />

      {/* Persistent global UI */}
      <div className="absolute top-[2vw] left-[2vw] flex items-center gap-[1vw] z-50">
        <motion.div
          animate={{
            backgroundColor: currentScene === 4 ? 'hsl(var(--destructive))' : (currentScene > 0 && currentScene < 6 ? 'hsl(var(--primary))' : 'hsl(var(--muted))'),
            boxShadow: currentScene === 4 ? '0 0 20px hsl(var(--destructive))' : (currentScene > 0 && currentScene < 6 ? '0 0 20px hsl(var(--primary))' : 'none')
          }}
          className="w-[0.8vw] h-[0.8vw] rounded-full"
        />
        <motion.div 
          className="font-mono text-[1vw] tracking-widest uppercase opacity-70"
          animate={{
            color: currentScene === 4 ? 'hsl(var(--destructive))' : (currentScene > 0 && currentScene < 6 ? 'hsl(var(--primary))' : 'hsl(var(--foreground))')
          }}
        >
          {currentScene === 0 && "SYSTEM.STANDBY"}
          {currentScene === 1 && "AGENT.DIAGNOSTICIAN"}
          {currentScene === 2 && "AGENT.REMEDIATOR"}
          {currentScene === 3 && "DB.CDC_STREAM"}
          {currentScene === 4 && "SYS.SIGKILL"}
          {currentScene === 5 && "AGENT.AUDITOR"}
          {currentScene === 6 && "SYSTEM.IDLE"}
        </motion.div>
      </div>

      <AnimatePresence mode="popLayout">
        {currentScene === 0 && <Scene0Hook key="s0" />}
        {currentScene === 1 && <Scene1Diagnose key="s1" />}
        {currentScene === 2 && <Scene2Repair key="s2" />}
        {currentScene === 3 && <Scene3Memory key="s3" />}
        {currentScene === 4 && <Scene4Chaos key="s4" />}
        {currentScene === 5 && <Scene5Learn key="s5" />}
        {currentScene === 6 && <Scene6Outro key="s6" />}
      </AnimatePresence>
    </div>
  );
}