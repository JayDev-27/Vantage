import React, { useEffect, useRef, useState } from 'react'

interface VideoLayerProps {
  src: string
  isPlaying: boolean
  performanceMode: string
}

export const VideoLayer: React.FC<VideoLayerProps> = ({ src, isPlaying, performanceMode }) => {
  const videoRef = useRef<HTMLVideoElement>(null)
  // Hidden until frames are actually playing, so the preview image shows instead of black.
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const shouldPlay = isPlaying && performanceMode !== 'pause'
    const tryPlay = () => {
      if (shouldPlay) {
        video.play().catch(() => { /* expected before data is loaded */ })
      }
    }

    if (!shouldPlay) {
      video.pause()
      return
    }

    // play() rejects until the new source has at least started loading; retry
    // once the element reports data instead of swallowing the failure forever.
    tryPlay()
    video.addEventListener('loadeddata', tryPlay)
    return () => video.removeEventListener('loadeddata', tryPlay)
  }, [isPlaying, performanceMode, src])

  // Always normal speed: slowing video in Battery Saver looked like a playback bug and
  // saved little power (decode cost is per frame shown, not playback rate).
  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = 1.0
  }, [src])

  useEffect(() => {
    if (!window.wallpaperApi?.onMemoryPurge) return
    return window.wallpaperApi.onMemoryPurge(() => {
      const video = videoRef.current
      if (!video) return
      const currentPos = video.currentTime
      video.load()
      video.currentTime = currentPos
      if (isPlaying && performanceMode !== 'pause') {
        const retryPlay = () => video.play().catch(() => {})
        video.addEventListener('loadeddata', retryPlay, { once: true })
        retryPlay()
      }
    })
  }, [isPlaying, performanceMode])

  return (
    <div className="w-full h-full relative overflow-hidden">
      <video
        ref={videoRef}
        src={src || undefined}
        loop
        muted
        playsInline
        onPlaying={() => setVisible(true)}
        onEmptied={() => setVisible(false)}
        className={`relative w-full h-full object-cover pointer-events-none transition-opacity duration-500 ${visible ? 'opacity-100' : 'opacity-0'}`}
      />
    </div>
  )
}
