import { motion } from "motion/react";
import { cn } from "@/lib/utils";
/* import appIcon from "../../../assets/img/Logo.png";
 */import introVideo from "../../../assets/img/zuno.mp4";

const LOADING_LINES = [
  " Finding your rhythm...",
  " Loading your library...",
  " Tuning the soundstage...",
  " Warming up the strings...",
  " Counting in...",
  " Preparing your session...",
  " Syncing your music...",
  " Building today's vibe...",
];

interface AppLoadingScreenProps {
  isLeaving: boolean;
}

export function AppLoadingScreen({ isLeaving }: AppLoadingScreenProps) {
  const loadingLine = LOADING_LINES[Math.floor(Math.random() * LOADING_LINES.length)];

  return (
    <div
      className={cn(
        "fixed inset-0 z-[100] grid place-items-center rounded-3xl bg-background transition-opacity duration-200",
        isLeaving ? "pointer-events-none opacity-0" : "opacity-100",
      )}
      role="status"
      aria-label="Loading"
      aria-live="polite"
    >
      
      {/* Accent bloom behind the mark. */}
      <div className="pointer-events-none absolute left-1/2 top-1/2 size-[420px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-orange-600/5 blur-[120px]" />

      <div className="relative flex flex-col items-center gap-5">
{/*         <motion.img
          initial={{ opacity: 0, scale: 0.92 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ type: "spring", stiffness: 260, damping: 24 }}
          className="size-20 rounded-2xl"
          src={appIcon}
          alt=""
        />  */}

<motion.video
  initial={{ opacity: 0, scale: 0.92 }}
  animate={{ opacity: 1, scale: 1 }}
  transition={{ type: "spring", stiffness: 260, damping: 24 }}
  className="size-18 drop-shadow-2xl backdrop-blur rounded-full object-cover
             [mask-image:radial-gradient(circle_at_center,black_58%,transparent_100%)]
             [-webkit-mask-image:radial-gradient(circle_at_center,black_58%,transparent_100%)]"
  autoPlay
  muted
  loop
  playsInline
  preload="auto"
>
  <source src={introVideo} type="video/mp4" />
</motion.video>
 
      <div className="flex items-end gap-4">
       {/*  <AudioLoader /> */}  <strong className="text-sm font-medium text-foreground">{loadingLine}</strong>
      </div>
        
      </div>
    </div>
  );
}
