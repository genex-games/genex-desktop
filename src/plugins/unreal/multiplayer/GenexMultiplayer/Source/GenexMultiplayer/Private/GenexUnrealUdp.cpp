// See GenexUnrealUdp.h.
#include "GenexUnrealUdp.h"

#include "GenexFastWireTap.h"

#include "IPAddress.h"
#include "SocketSubsystem.h"
#include "Sockets.h"

namespace GenexUnrealUdpDetail
{
/** The most bytes one receive reads: a datagram past fast::kMaxDatagramBytes is read whole and dropped by
 *  the decoder as oversized. */
constexpr int32 ReceiveBytes = 2048;

/** The tool's tap (GenexFastWireTap.h): sockets live on the game thread and so does the tool that sets it. */
FGenexFastWireTap WireTap = nullptr;

class FSocketUdp final : public genex::fast::DatagramSocket
{
public:
	FSocketUdp(ISocketSubsystem* InSubsystem, FSocket* InSocket) : Subsystem(InSubsystem), Socket(InSocket) {}
	virtual ~FSocketUdp() override { Close(); }

	virtual void Send(const std::uint8_t* Data, std::size_t Length) override
	{
		if (Socket == nullptr) return;
		int32 Sent = 0;
		// A failed send (an ICMP unreachable, a full buffer) is a lost datagram: the deadlines decide.
		const bool bTook = Socket->Send(Data, static_cast<int32>(Length), Sent);
		if (bTook && WireTap != nullptr) WireTap(true, Data, static_cast<int32>(Length));
	}

	virtual void Poll(const std::function<void(const std::uint8_t*, std::size_t)>& Receive) override
	{
		uint8 Buffer[ReceiveBytes];
		uint32 Pending = 0;
		while (Socket != nullptr && Socket->HasPendingData(Pending))
		{
			int32 Read = 0;
			if (!Socket->Recv(Buffer, ReceiveBytes, Read) || Read < 0) return;
			if (WireTap != nullptr) WireTap(false, Buffer, Read);
			Receive(Buffer, static_cast<std::size_t>(Read));
		}
	}

	virtual void Close() override
	{
		if (Socket == nullptr) return;
		Socket->Close();
		Subsystem->DestroySocket(Socket);
		Socket = nullptr;
	}

private:
	ISocketSubsystem* Subsystem;
	FSocket* Socket;
};
}  // namespace GenexUnrealUdpDetail

void GenexSetFastWireTap(FGenexFastWireTap Tap)
{
	GenexUnrealUdpDetail::WireTap = Tap;
}

std::unique_ptr<genex::fast::DatagramSocket> GenexOpenUnrealUdp(const std::string& url)
{
	const std::optional<genex::fast::UdpTarget> To = genex::fast::UdpEndpoint(url);
	if (!To) return nullptr;
	ISocketSubsystem* Subsystem = ISocketSubsystem::Get(PLATFORM_SOCKETSUBSYSTEM);
	if (Subsystem == nullptr) return nullptr;
	const FString Host = UTF8_TO_TCHAR(To->host.c_str());
	const FString Port = FString::FromInt(To->port);
	FAddressInfoResult Found = Subsystem->GetAddressInfo(*Host, *Port, EAddressInfoFlags::Default, NAME_None, ESocketType::SOCKTYPE_Datagram);
	if (Found.ReturnCode != SE_NO_ERROR || Found.Results.Num() == 0) return nullptr;
	const TSharedRef<FInternetAddr> Peer = Found.Results[0].Address;
	FSocket* Socket = Subsystem->CreateSocket(NAME_DGram, TEXT("GenexFast"), Peer->GetProtocolType());
	if (Socket == nullptr) return nullptr;
	// Connected: the kernel delivers only the endpoint's datagrams, so an off-path sender cannot inject one.
	if (!Socket->SetNonBlocking(true) || !Socket->Connect(*Peer))
	{
		Subsystem->DestroySocket(Socket);
		return nullptr;
	}
	return std::unique_ptr<genex::fast::DatagramSocket>(new GenexUnrealUdpDetail::FSocketUdp(Subsystem, Socket));
}
