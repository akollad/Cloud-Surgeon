import { motion } from 'framer-motion';

export function Scene0Hook() {
  return (
    <motion.div 
      className="absolute inset-0 flex flex-col items-center justify-center z-10"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, scale: 1.1, filter: 'blur(10px)' }}
      transition={{ duration: 1 }}
    >
      <motion.div
        initial={{ opacity: 0, y: '5vh' }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.5, duration: 1 }}
        className="text-center"
      >
        <motion.div 
          className="font-mono text-[4vw] text-muted-foreground mb-[2vw]"
          animate={{ opacity: [0.3, 1, 0.3] }}
          transition={{ repeat: Infinity, duration: 2 }}
        >
          02:00 AM
        </motion.div>
        
        <motion.h1 
          className="text-[6vw] font-bold leading-none tracking-tight mb-[4vw]"
          initial={{ clipPath: 'inset(0 100% 0 0)' }}
          animate={{ clipPath: 'inset(0 0% 0 0)' }}
          transition={{ delay: 1, duration: 1.5, ease: 'circOut' }}
        >
          When your<br/>
          <span className="text-transparent bg-clip-text bg-gradient-to-r from-accent to-destructive">
            checkout service
          </span><br/>
          goes down...
        </motion.h1>
      </motion.div>

      {/* Alert box */}
      <motion.div
        initial={{ opacity: 0, scale: 0.8, y: '10vh' }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ delay: 3, type: "spring", stiffness: 300, damping: 20 }}
        className="absolute bottom-[20vh] border border-destructive/50 bg-destructive/10 backdrop-blur-md px-[4vw] py-[2vw] rounded-lg"
      >
        <div className="flex items-center gap-[2vw]">
          <motion.div 
            animate={{ opacity: [1, 0, 1] }} 
            transition={{ repeat: Infinity, duration: 0.5 }}
            className="w-[2vw] h-[2vw] bg-destructive rounded-sm"
          />
          <div className="font-mono text-[2vw] text-destructive tracking-widest font-bold">
            P0: INCIDENT DETECTED
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}