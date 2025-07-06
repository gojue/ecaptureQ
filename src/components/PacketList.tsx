import { useState, useEffect, useRef } from 'react';
import { PacketCard } from '@/components/PacketCard';
import { PacketDetailModal } from '@/components/PacketDetailModal';
import type { HttpPacket } from '@/types';
import { isMobile } from '@/utils/httpParser';

interface PacketListProps {
  packets: HttpPacket[];
  showTimestamp: boolean;
  autoScroll: boolean;
}

export function PacketList({ packets, showTimestamp, autoScroll }: PacketListProps) {
  const [selectedPacket, setSelectedPacket] = useState<HttpPacket | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [mobile, setMobile] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // Check if mobile on mount and window resize
  useEffect(() => {
    const checkMobile = () => setMobile(isMobile());
    checkMobile();
    
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  // Auto scroll to bottom when new packets arrive
  useEffect(() => {
    if (autoScroll && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [packets, autoScroll]);

  const handlePacketClick = (packet: HttpPacket) => {
    setSelectedPacket(packet);
    setIsModalOpen(true);
  };

  const handleCloseModal = () => {
    setIsModalOpen(false);
    setSelectedPacket(null);
  };

  if (packets.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500 dark:text-gray-400">
        <div className="text-center">
          <div className="w-16 h-16 mx-auto mb-4 opacity-50">
            <svg viewBox="0 0 64 64" fill="currentColor">
              <path d="M32 2C15.431 2 2 15.431 2 32s13.431 30 30 30 30-13.431 30-30S48.569 2 32 2zm0 56C16.536 58 6 47.464 6 32S16.536 6 32 6s26 10.536 26 26-10.536 26-26 26z"/>
              <path d="M32 12c-11.046 0-20 8.954-20 20s8.954 20 20 20 20-8.954 20-20-8.954-20-20-20zm0 36c-8.837 0-16-7.163-16-16s7.163-16 16-16 16 7.163 16 16-7.163 16-16 16z"/>
              <circle cx="32" cy="32" r="4"/>
            </svg>
          </div>
          <p className="text-lg font-normal mb-2">No packets captured yet</p>
          <p className="text-sm">Waiting for HTTP traffic...</p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div 
        ref={listRef}
        className="flex-1 overflow-auto p-4 space-y-0"
      >
        {packets.map((packet) => (
          <PacketCard
            key={packet.id}
            packet={packet}
            onClick={handlePacketClick}
            showTimestamp={showTimestamp}
            isMobile={mobile}
          />
        ))}
      </div>

      <PacketDetailModal
        packet={selectedPacket}
        isOpen={isModalOpen}
        onClose={handleCloseModal}
        isMobile={mobile}
      />
    </>
  );
}
