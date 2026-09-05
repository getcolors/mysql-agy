terraform {
  required_version = ">= 1.8.0"
  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "2.51.0"
    }
  }
}

provider "digitalocean" {}

locals {
  name           = "<{ digitalocean-name }>"
  ssh_sources    = <{ digitalocean-ssh-sources-json|safe }>
  client_sources = <{ digitalocean-client-sources-json|safe }>
}

data "digitalocean_vpc" "cluster" {
  region = "<{ digitalocean-region }>"
}

<% if ssh-keygen %># Keygen mode (workspace standards/ssh-keypair.md): the account key is named
# after the profile and lives in this stack's state, which is what makes its
# ownership decidable. One key for the cluster, not one per member — the
# deployment is one thing, and a key per machine would multiply what the
# standard exists to make singular. Never reference a literal key id here in
# keygen mode.
resource "digitalocean_ssh_key" "machine" {
  name       = "<{ profile }>"
  public_key = trimspace(file("<{ ssh-public-key-path }>"))
}

<% endif %>resource "digitalocean_droplet" "node" {
  count    = <{ node-count }>
  name     = "${local.name}-node-${count.index + 1}"
  region   = "<{ digitalocean-region }>"
  size     = "<{ digitalocean-size }>"
  image    = "<{ digitalocean-image }>"
  vpc_uuid = data.digitalocean_vpc.cluster.id
<% if ssh-keygen %>  ssh_keys = [digitalocean_ssh_key.machine.id]
<% else %>  ssh_keys = ["<{ digitalocean-ssh-keys }>"]
<% endif %>  tags     = ["colors-mysql-agy", local.name]

  lifecycle {
    prevent_destroy = <{ compute-prevent-destroy }>
  }
}

resource "digitalocean_reserved_ip" "endpoint" {
  region = "<{ digitalocean-region }>"

  lifecycle {
    prevent_destroy = <{ compute-prevent-destroy }>
    ignore_changes  = [droplet_id]
  }
}

resource "digitalocean_firewall" "cluster" {
  name        = "${local.name}-cluster"
  droplet_ids = digitalocean_droplet.node[*].id

  inbound_rule {
    protocol         = "tcp"
    port_range       = "22"
    source_addresses = local.ssh_sources
  }
  inbound_rule {
    protocol         = "tcp"
    port_range       = "<{ mysql-port }>"
    source_addresses = local.client_sources
  }
  inbound_rule {
    protocol         = "icmp"
    source_addresses = concat(local.ssh_sources, [data.digitalocean_vpc.cluster.ip_range])
  }
  inbound_rule {
    protocol         = "tcp"
    port_range       = "1-65535"
    source_addresses = [data.digitalocean_vpc.cluster.ip_range]
  }
  inbound_rule {
    protocol         = "udp"
    port_range       = "1-65535"
    source_addresses = [data.digitalocean_vpc.cluster.ip_range]
  }

  outbound_rule {
    protocol              = "tcp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
  outbound_rule {
    protocol              = "udp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
  outbound_rule {
    protocol              = "icmp"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }

  lifecycle {
    prevent_destroy = <{ compute-prevent-destroy }>
  }
}

output "node_public_ips" {
  value = digitalocean_droplet.node[*].ipv4_address
}
output "node_private_ips" {
  value = digitalocean_droplet.node[*].ipv4_address_private
}
output "node_droplet_ids" {
  value = digitalocean_droplet.node[*].id
}
output "reserved_ip" {
  value = digitalocean_reserved_ip.endpoint.ip_address
}
output "vpc_id" {
  value = data.digitalocean_vpc.cluster.id
}
output "vpc_ip_range" {
  value = data.digitalocean_vpc.cluster.ip_range
}

# The Compute Cluster Standard's `params`: the one output every later stage
# reads. The outputs above stay so no state output disappears; after adoption
# nothing reads them but the legacy translation.
output "params" {
  value = {
    provider     = "digitalocean"
<% if ssh-keygen %>    ssh_key_id   = digitalocean_ssh_key.machine.id
<% endif %>    reserved_ip  = digitalocean_reserved_ip.endpoint.ip_address
    vpc_id       = data.digitalocean_vpc.cluster.id
    vpc_ip_range = data.digitalocean_vpc.cluster.ip_range
    nodes = [for i, d in digitalocean_droplet.node : {
      index      = i
      role       = null
      name       = d.name
      ip         = d.ipv4_address
      vpc_ip     = d.ipv4_address_private
      droplet_id = d.id
      user       = "root"
      sudoer     = "root"
    }]
  }
}
