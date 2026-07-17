import { motion } from 'framer-motion';

export function Scene5Learn() {
  return (
    <motion.div 
      className="absolute inset-0 flex items-center justify-center p-[5vw]"
      initial={{ opacity: 0, filter: 'blur(20px)' }}
      animate={{ opacity: 1, filter: 'blur(0px)' }}
      exit={{ opacity: 0, y: '-10vh' }}
      transition={{ duration: 1.5, ease: 'circOut' }}
    >
      <div className="w-full h-full flex flex-col justify-center max-w-[80vw]">
        
        <div className="font-mono text-accent text-[2vw] tracking-widest uppercase mb-[2vw] flex items-center gap-[1vw]">
          <div className="w-[1vw] h-[1vw] bg-accent rounded-full animate-pulse" />
          Auditor Agent
        </div>

        <h2 className="text-[5vw] font-bold leading-tight mb-[4vw] max-w-[60vw]">
          It doesn't just fix.<br/>
          <span className="text-primary">It learns.</span>
        </h2>

        {/* Learning visualization */}
        <div className="w-full bg-muted/20 border border-primary/20 rounded-xl p-[4vw] flex gap-[4vw] items-center relative overflow-hidden">
           
           <div className="flex-1 flex flex-col gap-[2vw] relative z-10">
              <div className="font-mono text-[1.5vw] text-foreground/60 mb-[1vw]">STRATEGY CALIBRATION</div>
              
              {/* Progress bars */}
              <div className="space-y-[1vw]">
                <div className="flex justify-between font-mono text-[1.2vw]">
                  <span>ECS Redeploy (Current)</span>
                  <span className="text-primary">92.4%</span>
                </div>
                <div className="w-full h-[0.5vw] bg-background rounded-full overflow-hidden">
                  <motion.div 
                    initial={{ width: 0 }} 
                    animate={{ width: '92.4%' }} 
                    transition={{ delay: 1, duration: 1.5, ease: 'easeOut' }}
                    className="h-full bg-primary"
                  />
                </div>
              </div>

              <div className="space-y-[1vw] mt-[2vw]">
                <div className="flex justify-between font-mono text-[1.2vw]">
                  <span className="text-accent">ECS Redeploy (Updated)</span>
                  <motion.span 
                    className="text-accent font-bold"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 3 }}
                  >
                    94.1%
                  </motion.span>
                </div>
                <div className="w-full h-[0.5vw] bg-background rounded-full overflow-hidden relative border border-accent/30">
                  {/* Base progress */}
                  <motion.div 
                    initial={{ width: '92.4%' }} 
                    animate={{ width: '92.4%' }} 
                    className="h-full bg-accent/50 absolute left-0"
                  />
                  {/* New progress */}
                  <motion.div 
                    initial={{ width: '92.4%' }} 
                    animate={{ width: '94.1%' }} 
                    transition={{ delay: 3, duration: 1, ease: 'easeOut' }}
                    className="h-full bg-accent absolute left-0"
                  />
                </div>
              </div>
           </div>

           {/* Arrow/Flow */}
           <motion.div 
             className="text-primary/40 text-[4vw]"
             initial={{ opacity: 0, x: -20 }}
             animate={{ opacity: 1, x: 0 }}
             transition={{ delay: 1.5 }}
           >
             →
           </motion.div>

           <div className="flex-1 bg-background/80 border border-primary/30 rounded-lg p-[3vw] z-10">
             <div className="font-mono text-[1.2vw] text-foreground/60 mb-[2vw]">VECTOR MEMORY UPDATE</div>
             <motion.div
               initial={{ opacity: 0 }}
               animate={{ opacity: 1 }}
               transition={{ delay: 2 }}
               className="font-mono text-[1.5vw] text-primary/80"
             >
               UPDATE strategies<br/>
               SET win_rate = 0.941<br/>
               WHERE id = 'st_8a9f2';
             </motion.div>
             <motion.div
               initial={{ opacity: 0, scale: 0.8 }}
               animate={{ opacity: 1, scale: 1 }}
               transition={{ delay: 4, type: 'spring' }}
               className="mt-[2vw] inline-block bg-primary/20 text-primary px-[1.5vw] py-[0.5vw] rounded font-bold text-[1.2vw]"
             >
               Playbook Written
             </motion.div>
           </div>

        </div>

      </div>
    </motion.div>
  );
}